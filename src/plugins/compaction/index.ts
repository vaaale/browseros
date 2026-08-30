import type { PluginDefinition, PluginContext } from "@/lib/plugins/types";

// Compaction plugin — registration/config-plumbing wrapper only (settings tab
// + assistant-exposed config tools). The actual pipeline is invoked directly
// by src/lib/agent/compaction/v2.ts's compactChatMessages() from
// src/lib/assistant/model-turn.ts; this plugin has no `hooks` of its own.

async function getCompactionConfig() {
  const { readCompactionConfig } = await import("@/lib/agent/compaction/config");
  return readCompactionConfig();
}

const compactionPlugin: PluginDefinition = {
  manifest: {
    id: "bos-compaction",
    name: "Context Compaction",
    version: "1.0.0",
    type: "server-plugin",
    provides: [],
    description:
      "Server-side context compaction. Layer 1 clears older tool results, Layer 2 async-summarizes past thresholds, Layer 3 truncates as a last resort.",
    settingsRegistration: {
      label: "Context Compaction",
      icon: "🗜️",
      order: 16,
      description: "Configure this in Settings -> Context Compaction (a dedicated tab with explanations and a live illustration), not here.",
    },
    configSchema: {
      type: "object",
      title: "Context Compaction",
      // Kept in sync with src/lib/agent/compaction/config.ts's CompactionConfig
      // shape / COMPACTION_DEFAULTS — this schema exists for the plugin SDK's
      // getConfig()/setConfig() contract and the assistant's auto-generated
      // config tools; the actual Settings UI is the dedicated CompactionTab.
      properties: {
        enabled: { type: "boolean", title: "Enabled", description: "Master switch. When off, the pipeline is a pass-through.", default: true },
        assumedContextTokens: { type: "number", title: "Assumed context window (tokens)", description: "Used when the provider does not declare a context size. Default 128000.", default: 128000 },
        clearThreshold: { type: "number", title: "Clear threshold (fraction of budget)", description: "Estimated tokens above this fraction trigger Layer 1 tool-result clearing. Default 0.50.", default: 0.5 },
        summarizeThreshold: { type: "number", title: "Summarize threshold (fraction of budget)", description: "Estimated tokens above this fraction schedule Layer 2 block summarization. Default 0.75.", default: 0.75 },
        hardLimit: { type: "number", title: "Hard limit (fraction of budget)", description: "Estimated tokens above this fraction trigger synchronous truncation. Default 0.92.", default: 0.92 },
        keepToolResults: { type: "number", title: "Keep last N tool-result pairs", description: "Tool-results older than the newest N pairs are eligible for clearing. Default 2.", default: 2 },
        keepTailTurns: { type: "number", title: "Keep tail turns", description: "Minimum number of most-recent turns kept fully verbatim. Default 3.", default: 3 },
        tailBudgetFraction: { type: "number", title: "Tail-budget fraction", description: "Target size of the kept tail as a fraction of the effective budget. Default 0.20.", default: 0.2 },
        unrecoverableTools: { type: "string", title: "Unrecoverable tools", description: "Comma or newline separated list of tool names whose calls/results must never be cleared or summarized away." },
        model: { type: "string", title: "Summarizer model override", description: "Optional cheaper model id for block summarization." },
        lockStalenessMs: { type: "number", title: "Lock staleness (ms)", description: "How long a stale block-formation lock is honored. Default 600000 (10 min).", default: 600000 },
        blockSize: { type: "number", title: "Block size (turns)", description: "Turns folded into one summary at a time. Default 5.", default: 5 },
        maxRetainedBlocks: { type: "number", title: "Max retained blocks", description: "Block summaries retained before the oldest is permanently discarded. Default 8.", default: 8 },
      },
    } as Record<string, unknown>,
  },
  hooks: {},
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
