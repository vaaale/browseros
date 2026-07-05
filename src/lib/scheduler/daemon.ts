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

// Memory Loops write into /Documents/Memory even before any loop has run —
// e.g. UI listings, the consolidator peeking at /Episodes. Seed the folders at
// daemon boot so first-write callers never trip on ENOENT.
async function ensureMemoryDirs(): Promise<void> {
  await mkdir("/Documents/Memory");
  await mkdir("/Documents/Memory/Episodes");
  await mkdir("/Documents/Memory/Topics");
}

export function startDaemon(opts: { tickMs?: number } = {}): void {
  void ensureMemoryDirs().catch((err) => {
    console.error("[scheduler] ensureMemoryDirs failed:", err);
  });
  installBuiltInHandlers();
  startEngineDaemon(opts);
}

/** Run a specific job immediately, out of band. */
export async function runTaskNow(job: JobDefinition): Promise<void> {
  installBuiltInHandlers();
  await runJobNow(job);
}
