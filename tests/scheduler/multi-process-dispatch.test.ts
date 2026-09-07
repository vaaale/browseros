import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { bundleForChildProcess } from "./_bundle";
import { dueJob, resetSchedulerState, useTestDataDir, writeJobStore } from "./_test-env";
import { listHistory } from "../../src/lib/scheduler/engine";
import { DAEMON_LOCK_NAME, jobLockName, lockPath, readLock } from "../../src/lib/scheduler/lock";

// The regression suite for 042-scheduler-daemon-lock.
//
// Every test here spawns REAL Node processes against ONE shared data dir,
// because that is the only way to reproduce the bug: the pre-fix engine's two
// guards — a module-level `runningJobIds` Set and the per-process globalThis
// daemon singleton — are both invisible across process boundaries, so N server
// processes (Supervisor BASE + PREVIEW, `next dev` workers) each dispatched the
// same due job in the same tick window. Against the unfixed engine the
// dispatch/run-now tests below record N markers instead of 1, and the election
// test sees every child claim ownership.

const CHILD_COUNT = 5;

interface Child {
  proc: ChildProcess;
  stdout: string;
  exited: Promise<number | null>;
}

function spawnChild(bundle: string, mode: string, env: Record<string, string>): Child {
  const proc = spawn(process.execPath, [bundle, mode], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const child: Child = {
    proc,
    stdout: "",
    exited: new Promise((resolve) => proc.on("exit", (code) => resolve(code))),
  };
  proc.stdout?.on("data", (chunk: Buffer) => {
    child.stdout += chunk.toString();
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    child.stdout += chunk.toString();
  });
  return child;
}

function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(poll, 20);
    };
    poll();
  });
}

function markerPids(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

test.describe("multi-process dispatch (042)", () => {
  test("N processes ticking the same due job dispatch it exactly once", async () => {
    test.setTimeout(90_000);
    resetSchedulerState();
    const { dir, cleanup } = useTestDataDir("scheduler-multi-tick");
    const children: Child[] = [];
    try {
      const bundle = await bundleForChildProcess(
        path.join(__dirname, "_child-worker.ts"),
        path.join(dir, "build"),
      );
      const jobId = "multi-tick-job";
      writeJobStore(dir, [dueJob(jobId, { name: "Daily Review (test)" })]);
      const marker = path.join(dir, "dispatches.log");

      // A shared future instant so all five processes hit tick() together —
      // spawn + module load is what would otherwise stagger them. The handler
      // then holds for 800ms, well past the point where every process has
      // already read the store, so nothing is deduped by chance.
      const barrier = Date.now() + 2_500;
      for (let i = 0; i < CHILD_COUNT; i++) {
        children.push(
          spawnChild(bundle, "dispatch", {
            BOS_DATA_DIR: dir,
            BOS_CANONICAL_DATA: dir,
            CHILD_MARKER: marker,
            CHILD_BARRIER: String(barrier),
            CHILD_JOB_ID: jobId,
            CHILD_HOLD_MS: "800",
          }),
        );
      }
      const codes = await Promise.all(children.map((c) => c.exited));
      expect(codes, children.map((c) => c.stdout).join("\n")).toEqual(
        new Array(CHILD_COUNT).fill(0),
      );

      // AC1: one dispatch, not N.
      expect(markerPids(marker)).toHaveLength(1);
      // ...and the engine agrees: a single execution was recorded.
      expect(await listHistory(jobId)).toHaveLength(1);
      // AC5: the job lock is released once the run finishes.
      expect(await readLock(jobLockName(jobId))).toBeNull();
    } finally {
      for (const c of children) c.proc.kill("SIGKILL");
      cleanup();
    }
  });

  test("N processes calling runJobNow on the same job dispatch it exactly once", async () => {
    test.setTimeout(90_000);
    resetSchedulerState();
    const { dir, cleanup } = useTestDataDir("scheduler-multi-runnow");
    const children: Child[] = [];
    try {
      const bundle = await bundleForChildProcess(
        path.join(__dirname, "_child-worker.ts"),
        path.join(dir, "build"),
      );
      const jobId = "multi-runnow-job";
      writeJobStore(dir, [dueJob(jobId)]);
      const marker = path.join(dir, "dispatches.log");

      // Same race, minus the schedule: runJobNow() skips the due-time filter
      // entirely, so this asserts the dispatch lock itself is exclusive with no
      // dependence on when each process happened to read nextRunAt.
      const barrier = Date.now() + 2_500;
      for (let i = 0; i < CHILD_COUNT; i++) {
        children.push(
          spawnChild(bundle, "run-now", {
            BOS_DATA_DIR: dir,
            BOS_CANONICAL_DATA: dir,
            CHILD_MARKER: marker,
            CHILD_BARRIER: String(barrier),
            CHILD_JOB_ID: jobId,
            CHILD_HOLD_MS: "800",
          }),
        );
      }
      const codes = await Promise.all(children.map((c) => c.exited));
      expect(codes, children.map((c) => c.stdout).join("\n")).toEqual(
        new Array(CHILD_COUNT).fill(0),
      );
      expect(markerPids(marker)).toHaveLength(1);
      expect(await listHistory(jobId)).toHaveLength(1);
    } finally {
      for (const c of children) c.proc.kill("SIGKILL");
      cleanup();
    }
  });

  test("only one process owns the daemon, and a killed owner is taken over", async () => {
    test.setTimeout(90_000);
    resetSchedulerState();
    const { dir, cleanup } = useTestDataDir("scheduler-election");
    const children: Child[] = [];
    try {
      const bundle = await bundleForChildProcess(
        path.join(__dirname, "_child-worker.ts"),
        path.join(dir, "build"),
      );
      writeJobStore(dir, []); // no jobs: this test is only about ownership
      const env = {
        BOS_DATA_DIR: dir,
        BOS_CANONICAL_DATA: dir,
        CHILD_MARKER: path.join(dir, "unused.log"),
        CHILD_ELECTION_MS: "300",
        CHILD_LIFETIME_MS: "60000",
      };

      const first = spawnChild(bundle, "elect", env);
      children.push(first);
      await waitFor(() => first.stdout.includes("OWNER"), 30_000, "first child to win the election");

      // AC2: the lock names the winner, and every later process stands down.
      const held = await readLock(DAEMON_LOCK_NAME);
      expect(held?.pid).toBe(first.proc.pid);
      expect(existsSync(lockPath(DAEMON_LOCK_NAME))).toBe(true);

      const rest = [1, 2].map(() => spawnChild(bundle, "elect", env));
      children.push(...rest);
      for (const c of rest) {
        await waitFor(() => c.stdout.includes("LOSER"), 30_000, "later child to lose the election");
        expect(c.stdout).not.toContain("OWNER");
      }
      expect((await readLock(DAEMON_LOCK_NAME))?.pid).toBe(first.proc.pid);

      // AC3: hard-kill the owner (no chance to release) — a loser must reclaim
      // the lock via PID liveness and resume scheduling.
      first.proc.kill("SIGKILL");
      await first.exited;
      await waitFor(
        () => rest.some((c) => c.stdout.includes("OWNER")),
        30_000,
        "a surviving child to take over the dead owner's lock",
      );
      const owners = rest.filter((c) => c.stdout.includes("OWNER"));
      expect(owners).toHaveLength(1);
      expect((await readLock(DAEMON_LOCK_NAME))?.pid).toBe(owners[0].proc.pid);
    } finally {
      for (const c of children) c.proc.kill("SIGKILL");
      cleanup();
    }
  });
});
