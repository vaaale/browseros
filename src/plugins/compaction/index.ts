import type { PluginDefinition, PluginContext, BosPluginHooks, ChatMessage, RunContext } from "@/lib/plugins/types";

// Compaction plugin — wraps the existing compaction middleware into a plugin.
// When active, the middleware delegates to this plugin's compactPrompt.
// When inactive, the middleware is a no-op pass-through.

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
    beforeRun: async (messages: ChatMessage[], ctx: RunContext) => {
      // The compaction plugin's beforeRun is a pass-through — actual compaction
      // happens at model-call time via the middleware. The hook is declared so
      // the plugin appears in the "provides" list.
      return undefined;
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
    const { patchNamespace } = await import("@/lib/config/store");
    await patchNamespace("compaction", config);
  },
};

export default compactionPlugin;
