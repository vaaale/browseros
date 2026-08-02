import "server-only";
import { logger } from "@/lib/logging";
import { serviceRegistry } from "./ServiceRegistry";
import { DEFAULT_CRASH_RECOVERY_POLICY } from "./types";
import type { CrashRecoveryPolicy } from "./types";

const COMPONENT = "services.crash-recovery";

interface PendingRestart {
  timer: NodeJS.Timeout;
  cancel: () => void;
}

const pending = new Map<string, PendingRestart>();

/** Nth restart's backoff: backoffMs * backoffMultiplier^(n-1) — 1s, 2s, 4s, 8s, 16s for defaults. */
export function computeBackoffMs(restartCount: number, policy: CrashRecoveryPolicy): number {
  return policy.backoffMs * Math.pow(policy.backoffMultiplier, Math.max(0, restartCount - 1));
}

export function shouldRestart(restartCount: number, policy: CrashRecoveryPolicy): boolean {
  return restartCount <= policy.maxRestarts;
}

/** Cancel a queued restart (e.g. the user manually stopped the service while
 *  it was waiting out its backoff). Idempotent — no-op if none is pending. */
export function cancelPendingRestart(serviceId: string): void {
  const entry = pending.get(serviceId);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.cancel();
  pending.delete(serviceId);
}

/**
 * Crash recovery entry point (CH-001/CH-005 fix consumer). Called from every
 * crash source: worker `exit` (non-zero code), worker `error`, and worker
 * `crash` IPC message. Increments the restart counter, decides whether to
 * retry (exponential backoff) or stop permanently, and — on retry — calls
 * back into ServiceManager.start() once the backoff elapses.
 */
export async function handleCrash(serviceId: string, errorMessage: string, stack?: string, policy: CrashRecoveryPolicy = DEFAULT_CRASH_RECOVERY_POLICY): Promise<void> {
  const registry = serviceRegistry();
  const def = registry.getService(serviceId);
  if (!def) return;

  registry.setWorker(serviceId, null);
  const restartCount = registry.incrementRestart(serviceId);
  registry.emit({ type: "service:crash", id: serviceId, error: errorMessage, stack, restartCount });
  logger().error(COMPONENT, `service "${serviceId}" crashed: ${errorMessage}`, undefined, { serviceId, restartCount, stack });

  if (!shouldRestart(restartCount, policy)) {
    registry.setState(serviceId, "crashed", errorMessage);
    logger().error(
      COMPONENT,
      `service "${serviceId}" exceeded max restarts (${policy.maxRestarts}) — stopping permanently`,
      undefined,
      { serviceId, restartCount },
    );
    return;
  }

  registry.setState(serviceId, "restarting");
  const backoffMs = computeBackoffMs(restartCount, policy);
  logger().warn(COMPONENT, `service "${serviceId}" will restart in ${backoffMs}ms (attempt ${restartCount}/${policy.maxRestarts})`, {
    serviceId,
    backoffMs,
    restartCount,
  });

  cancelPendingRestart(serviceId);
  const cancelled = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(serviceId);
      resolve(false);
    }, backoffMs);
    timer.unref?.();
    pending.set(serviceId, { timer, cancel: () => resolve(true) });
  });
  if (cancelled) return;

  const { serviceManager } = await import("./ServiceManager");
  try {
    await serviceManager().start(serviceId);
  } catch (err) {
    logger().error(COMPONENT, `service "${serviceId}" restart attempt failed`, err, { serviceId, restartCount });
  }
}
