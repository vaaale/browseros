import "server-only";
import { installBuiltInHandlers } from "./executor";
import {
  getDaemonStatus,
  runJobNow,
  startDaemon as startEngineDaemon,
  stopDaemon,
  tick,
  type DaemonStatus,
} from "./engine";
import type { JobDefinition } from "./types";
import { mkdir } from "@/os/vfs";

// Thin façade over the Unified Job Engine daemon (engine.ts). Kept as a stable
// import path for callers that already do `import { startDaemon } from
// "@/lib/scheduler/daemon"`. Installs the built-in prompt handler on first
// start so scheduled agent prompts continue to work.

export type { DaemonStatus };
export { getDaemonStatus, stopDaemon, tick };

// Seed the /Memories root at daemon boot so listing callers never trip on
// ENOENT before any agent has written their first memory.
async function ensureMemoryRoot(): Promise<void> {
  await mkdir("/Memories");
}

export function startDaemon(opts: { tickMs?: number } = {}): void {
  void ensureMemoryRoot().catch((err) => {
    console.error("[scheduler] ensureMemoryRoot failed:", err);
  });
  installBuiltInHandlers();
  startEngineDaemon(opts);
}

/** Run a specific job immediately, out of band. */
export async function runTaskNow(job: JobDefinition): Promise<void> {
  installBuiltInHandlers();
  await runJobNow(job);
}
