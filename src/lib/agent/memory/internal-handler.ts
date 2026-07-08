import "server-only";
import { logger } from "@/lib/logging";
import { registerHandler, type HandlerRunResult } from "@/lib/scheduler/engine";
import type { JobDefinition, JobHandler } from "@/lib/scheduler/types";

// Shared registrar for `internal`-kind JobDefinition handlers. The engine's
// registerHandler is keyed by `handler.kind`, but multiple subsystems (fast
// loop, slow loop, and eventually other internal jobs) want to co-exist under
// the single `internal` kind. This module owns the one-time
// registerHandler("internal", ...) call and exposes a per-ref dispatch table.

const LOG = "memory.internal-handler";

const dispatchers = new Map<string, (job: JobDefinition) => Promise<HandlerRunResult>>();
let installed = false;

function dispatch(handler: JobHandler, job: JobDefinition): Promise<HandlerRunResult> {
  if (handler.kind !== "internal") {
    return Promise.resolve({ status: "error", error: `internal dispatcher received wrong kind: ${handler.kind}` });
  }
  const fn = dispatchers.get(handler.ref);
  if (!fn) {
    return Promise.resolve({ status: "error", error: `No internal handler registered for ref "${handler.ref}"` });
  }
  return fn(job);
}

/** Idempotent: register the shared `internal` dispatcher with the engine. */
export function installInternalHandler(): void {
  if (installed) return;
  installed = true;
  registerHandler("internal", dispatch);
  logger().info(LOG, "internal handler installed");
}

/** Register the concrete function for one ref (e.g. "memory.fast-loop"). Idempotent. */
export function registerInternalRef(
  ref: string,
  fn: (job: JobDefinition) => Promise<HandlerRunResult>,
): void {
  installInternalHandler();
  dispatchers.set(ref, fn);
}
