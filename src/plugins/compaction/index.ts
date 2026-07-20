import type { PluginDefinition, PluginContext } from "@/lib/plugins/types";

// Compaction plugin — wraps the existing compaction middleware into a plugin.
// When active, the middleware delegates to this plugin's beforeRun hook which
// calls compactChatMessages. When inactive, the middleware applies the default
// compaction logic directly.

async function getCompactionConfig() {
  const { readCompactionConfig } = await import("@/lib/agent/compaction/config");
  return readCompactionConfig();
}

async function getCompactPrompt() {
  const { compactPrompt } = await import("@/lib/agent/compaction/middleware");
  return compactPrompt;
}

async function getWithCompaction() {
  const { withCompaction } = await import("@/lib/agent/compaction/middleware");
  return withCompaction;
}

/** The compaction plugin's core function: compact a v3 prompt array. */
export async function compactionCompactPrompt(
  convId: string,
  prompt: unknown,
  maxOutputTokens?: number,
): Promise<unknown> {
  const compactPrompt = await getCompactPrompt();
  const config = await getCompactionConfig();
  if (!config.enabled) return prompt;
  return compactPrompt(convId, prompt as never, maxOutputTokens);
}

/** Wrap an AI-SDK LanguageModel with compaction middleware. */
export async function compactionWrapModel(model: unknown, convId: string): Promise<unknown> {
  const withCompaction = await getWithCompaction();
  return withCompaction(model as never, convId);
}

const compactionPlugin: PluginDefinition = {
  manifest: {
    id: "bos-compaction",
    name: "Context Compaction",
    version: "1.0.0",
    type: "server-plugin",
    provides: ["beforeRun"],
    description:
      "Server-side context compaction. Layer 1 clears older tool results, Layer 2 async-summarizes past thresholds, Layer 3 truncates as a last resort.",
    settingsRegistration: {
      label: "Context Compaction",
      icon: "🗜️",
      order: 16,
      description: "Server-side view transformation on what is sent to the model.",
    },
  },
  hooks: {
    beforeRun: async (messages, ctx) => {
      // Delegate to the existing compaction system via compactChatMessages.
      // The compaction middleware (middleware.ts) skips its own logic when this
      // plugin is active, so this is the sole compaction entry point.
      const config = await getCompactionConfig();
      if (!config.enabled) return undefined;

      try {
        const { compactChatMessages } = await import("@/lib/agent/compaction/v2");
        // compactChatMessages converts ChatMessage[] → v3 prompt, runs
        // compaction, and converts back. The system prompt is composed
        // separately (not in the messages array) so we pass an empty string;
        // the compaction logic operates on message content regardless.
        const compacted = await compactChatMessages(
          ctx.conversationId,
          "",
          messages as never,
          undefined,
        );
        if (compacted.length === 0) return undefined;
        return compacted as typeof messages;
      } catch {
        // On error, pass through unchanged — same as the middleware's safety net.
        return undefined;
      }
    },
  },
  initialize: async (ctx: PluginContext) => {
    ctx.log("info", "compaction plugin initialized");
  },
  dispose: async () => {
    // Nothing to clean up — compaction middleware reads config dynamically.
  },
  getConfig: async () => {
    const config = await getCompactionConfig();
    return config as unknown as Record<string, unknown>;
  },
  setConfig: async (config: Record<string, unknown>) => {
    const { patchPluginConfig } = await import("@/lib/plugins/registry");
    await patchPluginConfig("bos-compaction", config);
  },
};

export default compactionPlugin;
