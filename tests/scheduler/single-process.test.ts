import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { existsSync } from "fs";
import { dueJob, resetSchedulerState, useTestDataDir, writeJobStore } from "./_test-env";
import {
  getDaemonStatus,
  getJob,
  invalidateCache,
  listHistory,
  readDaemonStatus,
  registerHandler,
  startDaemon,
  stopDaemon,
} from "../../src/lib/scheduler/engine";
import { DAEMON_LOCK_NAME, jobLockName, lockPath, readLock } from "../../src/lib/scheduler/lock";

// AC5 for 042-scheduler-daemon-lock: the single-process case — the only one
// most installs ever see — must behave exactly as it did before the lock
// existed. One process wins its own election immediately, jobs fire on
// schedule, the next-run math is untouched, and locks are released after a run.

function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("waitUntil timed out"));
      setTimeout(poll, 10);
    };
    poll();
  });
}

test.describe("single-process scheduler (042 no-regression)", () => {
  test("a lone process elects itself, fires the due job, and advances nextRunAt", async () => {
    test.setTimeout(30_000);
    resetSchedulerState();
    invalidateCache();
    const { dir, cleanup } = useTestDataDir("scheduler-single");
    try {
      const jobId = "single-process-job";
      writeJobStore(dir, [
        dueJob(jobId, { scheduleConfig: { type: "recurring", interval: 1, unit: "minute" } }),
      ]);
      let runs = 0;
      registerHandler("internal", async () => {
        runs++;
        return { status: "success", output: "ok" };
      });

      startDaemon({ tickMs: 100, electionMs: 100 });
      await waitUntil(() => getDaemonStatus().running);
      // Nothing to contend with, so this process owns the daemon.
      expect(getDaemonStatus().owner).toBe(true);
      expect((await readLock(DAEMON_LOCK_NAME))?.pid).toBe(process.pid);
      expect(await readDaemonStatus()).toMatchObject({ running: true, owner: true });

      await waitUntil(() => runs > 0);
      // The tick loop keeps running, but the job is no longer due — one run.
      await new Promise((r) => setTimeout(r, 400));
      expect(runs).toBe(1);
      expect(await listHistory(jobId)).toHaveLength(1);

      // Next-run math unchanged: lastExecutedAt + exactly one interval.
      invalidateCache();
      const after = await getJob(jobId);
      expect(after?.lastExecutedAt).toBeTruthy();
      expect(Date.parse(after!.nextRunAt!) - Date.parse(after!.lastExecutedAt!)).toBe(60_000);

      // The per-job lock is released once the run completes.
      expect(await readLock(jobLockName(jobId))).toBeNull();

      // A second startDaemon() is still a no-op, and stopDaemon() hands the
      // daemon lock back so another process can take over immediately.
      startDaemon({ tickMs: 100 });
      expect(getDaemonStatus().running).toBe(true);
      stopDaemon();
      expect(getDaemonStatus().running).toBe(false);
      expect(existsSync(lockPath(DAEMON_LOCK_NAME))).toBe(false);
    } finally {
      stopDaemon();
      cleanup();
    }
  });

  test("a paused job is not dispatched and takes no lock", async () => {
    test.setTimeout(30_000);
    resetSchedulerState();
    invalidateCache();
    const { dir, cleanup } = useTestDataDir("scheduler-single-paused");
    try {
      const jobId = "paused-job";
      writeJobStore(dir, [dueJob(jobId, { status: "paused", nextRunAt: null })]);
      let runs = 0;
      registerHandler("internal", async () => {
        runs++;
        return { status: "success" };
      });

      startDaemon({ tickMs: 100, electionMs: 100 });
      await waitUntil(() => getDaemonStatus().running);
      await new Promise((r) => setTimeout(r, 500));

      expect(runs).toBe(0);
      expect(await listHistory(jobId)).toHaveLength(0);
      expect(existsSync(lockPath(jobLockName(jobId)))).toBe(false);
    } finally {
      stopDaemon();
      cleanup();
    }
  });
});
