import type { BosPluginHooks } from "./types";
import { trackStart, trackEnd } from "./monitor";
import { logger } from "@/lib/logging";

// Plugin sandbox — wraps plugin hooks with execution monitoring and error
// containment. Plugins run in-process (no process isolation per NFR-001) but
// hooks are guarded with timeouts and catch-and-log per NFR-004.

const COMPONENT = "plugins.sandbox";

/** Wrap a plugin's hooks with monitoring and error containment. */
export function wrapPluginSandbox(
  pluginId: string,
  hooks: BosPluginHooks,
  _pluginDir: string,
): BosPluginHooks {
  const wrapped: Record<string, unknown> = {};

  for (const [hookName, hookFn] of Object.entries(hooks)) {
    if (typeof hookFn !== "function") continue;

    wrapped[hookName] = async (...args: unknown[]) => {
      const key = trackStart(pluginId, hookName);
      try {
        const result = await (hookFn as (...a: unknown[]) => Promise<unknown>)(...args);
        return result;
      } catch (err) {
        logger().error(COMPONENT, `hook.threw: ${pluginId}.${hookName}`, undefined, {
          error: (err as Error).message,
          pluginId,
          hookName,
        });
        return undefined;
      } finally {
        trackEnd(key);
      }
    };
  }

  return wrapped as unknown as BosPluginHooks;
}
