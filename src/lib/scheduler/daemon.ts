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

// Thin façade over the Unified Job Engine daemon (engine.ts). Kept as a stable
// import path for callers that already do `import { startDaemon } from
// "@/lib/scheduler/daemon"`. Installs the built-in prompt handler on first
// start so scheduled agent prompts continue to work.

export type { DaemonStatus };
export { getDaemonStatus, stopDaemon, tick };

export function startDaemon(opts: { tickMs?: number } = {}): void {
  installBuiltInHandlers();
  startEngineDaemon(opts);
}

/** Run a specific job immediately, out of band. */
export async function runTaskNow(job: JobDefinition): Promise<void> {
  installBuiltInHandlers();
  await runJobNow(job);
}
