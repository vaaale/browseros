import type { PluginDefinition, PluginContext } from "@/lib/plugins/types";

// Memory plugin — wraps the existing memory system (fast-loop + slow-loop)
// into a plugin. The memory loops run as scheduler jobs; the plugin provides
// the onRunFinished hook to trigger the fast-loop review after each run.

async function getMemoryLoopsConfig() {
  const { getMemoryLoopsConfig } = await import("@/lib/agent/memory/config");
  return getMemoryLoopsConfig();
}

const memoryPlugin: PluginDefinition = {
  manifest: {
    id: "bos-memory",
    name: "Memory System",
    version: "1.0.0",
    type: "server-plugin",
    provides: ["onRunFinished", "afterRun"],
    description:
      "Automated memory reflection. Fast loop reviews idle conversations and writes episodes; slow loop consolidates into long-term memory.",
    settingsRegistration: {
      label: "Memory Loops",
      icon: "🧠",
      order: 15,
      description: "Automated memory reflection and consolidation.",
    },
  },
  hooks: {
    afterRun: async () => {
      // The memory fast-loop is triggered by the scheduler, not inline here.
      // This hook is a placeholder for future per-run memory operations.
      return undefined;
    },
    onRunFinished: async (summary, ctx) => {
      // When a run completes successfully, trigger the fast-loop for this
      // conversation. The fast-loop runs asynchronously and checks eligibility
      // (idle threshold, turn cap, etc.) before doing any work.
      if (summary.reason !== "completed") return;

      const config = await getMemoryLoopsConfig().catch(() => null);
      if (!config?.fastLoop.enabled) return;

      try {
        const { runFastLoop } = await import("@/lib/agent/memory/fast-loop");
        // Fire-and-forget: the fast-loop scans all eligible conversations;
        // pass onlyConversationId for a targeted check.
        void runFastLoop({ onlyConversationId: ctx.conversationId }).catch(
          (err: unknown) => {
            // Log but never throw — onRunFinished is a fire-and-forget hook.
            console.error("[memory-plugin] fast-loop trigger failed:", (err as Error).message);
          },
        );
      } catch {
        // Import failure — non-fatal.
      }
    },
  },
  initialize: async (ctx: PluginContext) => {
    ctx.log("info", "memory plugin initialized");
  },
  dispose: async () => {
    // Memory loops are scheduler jobs — they stop when the scheduler stops.
  },
  getConfig: async () => {
    const config = await getMemoryLoopsConfig();
    return config as unknown as Record<string, unknown>;
  },
  setConfig: async (config: Record<string, unknown>) => {
    const { patchNamespace } = await import("@/lib/config/store");
    await patchNamespace("memoryLoops", config);
  },
};

export default memoryPlugin;
