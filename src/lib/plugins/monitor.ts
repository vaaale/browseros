import "server-only";
import { logger } from "@/lib/logging";

// Plugin execution monitor — tracks active hook invocations and detects hangs.

const COMPONENT = "plugins.monitor";

interface ActiveInvocation {
  pluginId: string;
  hookName: string;
  startedAt: number;
  conversationId?: string;
}

const g = globalThis as unknown as { __bosPluginMonitor?: Map<string, ActiveInvocation> };

function active(): Map<string, ActiveInvocation> {
  if (!g.__bosPluginMonitor) g.__bosPluginMonitor = new Map();
  return g.__bosPluginMonitor;
}

/** Maximum time a single hook invocation can run before it's flagged as hung. */
const HANG_THRESHOLD_MS = 30_000;

let hangCheckTimer: ReturnType<typeof setInterval> | null = null;

function ensureHangCheck(): void {
  if (hangCheckTimer) return;
  hangCheckTimer = setInterval(() => {
    const now = Date.now();
    for (const [, inv] of active()) {
      const elapsed = now - inv.startedAt;
      if (elapsed > HANG_THRESHOLD_MS) {
        logger().warn(COMPONENT, "hook.potential-hang", {
          data: {
            pluginId: inv.pluginId,
            hookName: inv.hookName,
            elapsedMs: elapsed,
            conversationId: inv.conversationId,
          },
        });
      }
    }
  }, 10_000);
  hangCheckTimer.unref?.();
}

/** Track a hook invocation start. Returns a tracking key. */
export function trackStart(pluginId: string, hookName: string, conversationId?: string): string {
  const key = `${pluginId}:${hookName}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  active().set(key, { pluginId, hookName, startedAt: Date.now(), conversationId });
  ensureHangCheck();
  return key;
}

/** Track a hook invocation end. */
export function trackEnd(key: string): void {
  active().delete(key);
  if (active().size === 0 && hangCheckTimer) {
    clearInterval(hangCheckTimer);
    hangCheckTimer = null;
  }
}

/** Get currently active invocations (for diagnostics). */
export function getActiveInvocations(): ActiveInvocation[] {
  return [...active().values()];
}
