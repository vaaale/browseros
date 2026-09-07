import "../services/_stub-server-only";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import type { JobDefinition } from "../../src/lib/scheduler/types";

export { useTestDataDir } from "../services/_test-env";

/** Reset the engine's hot-reload-safe globalThis daemon state between tests so
 *  a previous test's election/tick state never leaks into the next one. */
export function resetSchedulerState(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.__bosSchedulerState;
}

/** The host path of the job store inside a test data dir. */
export function jobsStorePath(dir: string): string {
  return path.join(dir, "vfs", "Documents", "System", "scheduler-jobs.json");
}

/**
 * Write the job store directly (the engine picks it up via its mtime check —
 * the same path a user editing the file by hand takes). Used instead of
 * createJob() because these tests need a job whose nextRunAt is unambiguously
 * in the PAST, i.e. due right now in every process that reads it.
 */
export function writeJobStore(dir: string, jobs: JobDefinition[]): void {
  const file = jobsStorePath(dir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ jobs, _meta: { version: 1 } }, null, 2), "utf8");
}

/** A due, recurring, internal-handler job — the shape of a "Daily Review". */
export function dueJob(id: string, overrides: Partial<JobDefinition> = {}): JobDefinition {
  const now = Date.now();
  return {
    id,
    name: `Test Job ${id}`,
    category: "user",
    handler: { kind: "internal", ref: "test.marker" },
    scheduleType: "recurring",
    scheduleConfig: { type: "recurring", interval: 1, unit: "hour" },
    status: "active",
    nextRunAt: new Date(now - 60_000).toISOString(),
    createdAt: new Date(now - 3_600_000).toISOString(),
    updatedAt: new Date(now - 3_600_000).toISOString(),
    ...overrides,
  };
}
