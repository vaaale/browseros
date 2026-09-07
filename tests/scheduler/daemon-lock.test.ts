import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { spawn } from "child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import os from "os";
import path from "path";
import { resetSchedulerState, useTestDataDir } from "./_test-env";
import {
  DEFAULT_LOCK_MAX_AGE_MS,
  acquireLock,
  isPidAlive,
  isReclaimable,
  jobLockName,
  lockPath,
  lockRoot,
  readLock,
  refreshLock,
  releaseLock,
  releaseLockSync,
  type LockRecord,
} from "../../src/lib/scheduler/lock";

// Unit coverage for the lock primitive behind 042-scheduler-daemon-lock. The
// cross-process behaviour is proven in multi-process-dispatch.test.ts; this
// file pins the rules that file can only observe indirectly — atomicity,
// PID-liveness, stale reclaim, and refusing to touch someone else's lock.

/** A pid that is guaranteed dead: spawn a process and wait for it to exit. */
async function deadPid(): Promise<number> {
  const proc = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = proc.pid!;
  await new Promise<void>((resolve) => proc.on("exit", () => resolve()));
  // exit fires once the process is reaped, so the pid is no longer live.
  return pid;
}

function writeRecord(name: string, rec: Partial<LockRecord>): LockRecord {
  const file = lockPath(name);
  mkdirSync(path.dirname(file), { recursive: true });
  const full: LockRecord = {
    name,
    pid: process.pid,
    host: os.hostname(),
    token: "pre-existing-token",
    acquiredAt: Date.now(),
    heartbeatAt: Date.now(),
    ...rec,
  };
  writeFileSync(file, JSON.stringify(full, null, 2), "utf8");
  return full;
}

test.describe("scheduler lock primitive (042)", () => {
  test("concurrent acquisitions of the same lock: exactly one wins", async () => {
    resetSchedulerState();
    const { cleanup } = useTestDataDir("lock-exclusive");
    try {
      const results = await Promise.all(
        Array.from({ length: 12 }, () => acquireLock("daemon")),
      );
      const winners = results.filter((h) => h !== null);
      expect(winners).toHaveLength(1);
      // The file on disk names the winner, not a later racer.
      expect((await readLock("daemon"))?.token).toBe(winners[0]!.token);
    } finally {
      cleanup();
    }
  });

  test("lives under the canonical data root, so BASE and PREVIEW share it", async () => {
    resetSchedulerState();
    const { dir, cleanup } = useTestDataDir("lock-root");
    try {
      // A preview runs with its own BOS_DATA_DIR but the SAME
      // BOS_CANONICAL_DATA, which is why the lock is rooted in the latter.
      process.env.BOS_DATA_DIR = path.join(dir, "preview-clone");
      expect(lockRoot()).toBe(path.join(dir, "scheduler"));
      expect(lockPath(jobLockName("abc"))).toBe(
        path.join(dir, "scheduler", "job-locks", "abc.lock"),
      );
      const handle = await acquireLock("daemon");
      expect(handle).not.toBeNull();
      expect(existsSync(path.join(dir, "scheduler", "daemon.lock"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("a lock held by a live process with a fresh heartbeat is refused", async () => {
    resetSchedulerState();
    const { cleanup } = useTestDataDir("lock-refused");
    try {
      writeRecord("daemon", { pid: process.pid, heartbeatAt: Date.now() });
      expect(await acquireLock("daemon")).toBeNull();
      // ...and the holder's record is left untouched.
      expect((await readLock("daemon"))?.token).toBe("pre-existing-token");
    } finally {
      cleanup();
    }
  });

  test("a lock whose owner PID is gone is reclaimed immediately", async () => {
    resetSchedulerState();
    const { cleanup } = useTestDataDir("lock-dead-pid");
    try {
      const pid = await deadPid();
      // Heartbeat is FRESH: only PID liveness can justify the reclaim here,
      // which is what keeps a crashed owner from wedging the scheduler for a
      // whole staleness window.
      writeRecord("daemon", { pid, heartbeatAt: Date.now() });
      const handle = await acquireLock("daemon");
      expect(handle).not.toBeNull();
      expect((await readLock("daemon"))?.pid).toBe(process.pid);
    } finally {
      cleanup();
    }
  });

  test("a lock with an aged-out heartbeat is reclaimed even if the PID is alive", async () => {
    resetSchedulerState();
    const { cleanup } = useTestDataDir("lock-stale-heartbeat");
    try {
      writeRecord("daemon", {
        pid: process.pid,
        heartbeatAt: Date.now() - DEFAULT_LOCK_MAX_AGE_MS - 1_000,
      });
      const handle = await acquireLock("daemon");
      expect(handle).not.toBeNull();
      expect((await readLock("daemon"))?.token).toBe(handle!.token);
    } finally {
      cleanup();
    }
  });

  test("a truncated/garbage lock file is treated as reclaimable", async () => {
    resetSchedulerState();
    const { cleanup } = useTestDataDir("lock-garbage");
    try {
      const file = lockPath("daemon");
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, '{"pid": 1', "utf8"); // killed mid-write
      expect(await acquireLock("daemon")).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  test("PID liveness: EPERM (someone else's process) counts as alive", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    // pid 1 exists in every container; whether we may signal it or not, it is
    // alive — a permission error must never be read as "free to steal".
    expect(isPidAlive(1)).toBe(true);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
  });

  test("PID liveness is only trusted for records from this host", async () => {
    const pid = await deadPid();
    const base: LockRecord = {
      name: "daemon",
      pid,
      host: os.hostname(),
      token: "t",
      acquiredAt: Date.now(),
      heartbeatAt: Date.now(),
    };
    expect(isReclaimable(base, DEFAULT_LOCK_MAX_AGE_MS)).toBe(true);
    // Same dead pid number, but written by a different host: the number means
    // nothing here, so only the heartbeat may expire it.
    expect(isReclaimable({ ...base, host: "some-other-container" }, DEFAULT_LOCK_MAX_AGE_MS)).toBe(
      false,
    );
    expect(
      isReclaimable(
        { ...base, host: "some-other-container", heartbeatAt: Date.now() - 120_000 },
        DEFAULT_LOCK_MAX_AGE_MS,
      ),
    ).toBe(true);
  });

  test("refresh advances the heartbeat, and reports false once the lock is taken", async () => {
    resetSchedulerState();
    const { cleanup } = useTestDataDir("lock-refresh");
    try {
      const handle = (await acquireLock("daemon"))!;
      const before = (await readLock("daemon"))!.heartbeatAt;
      await new Promise((r) => setTimeout(r, 15));
      expect(await refreshLock(handle)).toBe(true);
      expect((await readLock("daemon"))!.heartbeatAt).toBeGreaterThan(before);

      // Simulate a takeover by another process.
      writeRecord("daemon", { token: "someone-else", pid: process.pid });
      expect(await refreshLock(handle)).toBe(false);
      // A lock that is no longer ours must not be deleted by us.
      await releaseLock(handle);
      expect((await readLock("daemon"))?.token).toBe("someone-else");
      releaseLockSync(handle);
      expect((await readLock("daemon"))?.token).toBe("someone-else");
    } finally {
      cleanup();
    }
  });

  test("release frees the lock for the next contender (sync and async)", async () => {
    resetSchedulerState();
    const { cleanup } = useTestDataDir("lock-release");
    try {
      const first = (await acquireLock("daemon"))!;
      expect(await acquireLock("daemon")).toBeNull();
      await releaseLock(first);
      expect(await readLock("daemon")).toBeNull();

      const second = (await acquireLock("daemon"))!;
      releaseLockSync(second);
      expect(existsSync(lockPath("daemon"))).toBe(false);
      expect(await acquireLock("daemon")).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  test("acquisition leaves no staging files behind", async () => {
    resetSchedulerState();
    const { dir, cleanup } = useTestDataDir("lock-staging");
    try {
      await Promise.all(Array.from({ length: 6 }, () => acquireLock("daemon")));
      const entries = readFileSync(lockPath("daemon"), "utf8");
      expect(entries.length).toBeGreaterThan(0);
      const { readdirSync } = await import("fs");
      const files = readdirSync(path.join(dir, "scheduler"));
      expect(files.filter((f) => f.includes(".staged.") || f.includes(".stale."))).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
