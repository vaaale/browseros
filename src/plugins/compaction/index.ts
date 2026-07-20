import type { PluginDefinition, PluginContext } from "@/lib/plugins/types";
import { logger } from "@/lib/logging";

// Compaction plugin — wraps the existing compaction middleware into a plugin.

function log(level: "debug" | "info" | "warn" | "error", convId: string, msg: string, data?: Record<string, unknown>): void {
  logger().log({ level, component: "plugins.compaction", conversation: convId, msg, ...(data ? { data } : {}) });
}

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
    configSchema: {
      type: "object",
      title: "Context Compaction",
      properties: {
        enabled: { type: "boolean", title: "Enabled", description: "Master switch. When off, the middleware is a pass-through.", default: true },
        assumedContextTokens: { type: "number", title: "Assumed context window (tokens)", description: "Used when the provider does not declare a maxInputTokens. Default 128000.", default: 128000 },
        clearThreshold: { type: "number", title: "Clear threshold (fraction of budget)", description: "Estimated tokens above this fraction trigger Layer 1 tool-result clearing. Default 0.50.", default: 0.5 },
        summarizeThreshold: { type: "number", title: "Summarize threshold (fraction of budget)", description: "Estimated tokens above this fraction schedule Layer 2 summarization. Default 0.75.", default: 0.75 },
        hardLimit: { type: "number", title: "Hard limit (fraction of budget)", description: "Estimated tokens above this fraction trigger synchronous truncation. Default 0.92.", default: 0.92 },
        keepToolResults: { type: "number", title: "Keep last N tool-result pairs", description: "Tool-results older than the newest N pairs are eligible for clearing. Default 5.", default: 5 },
        keepTailMessages: { type: "number", title: "Minimum tail messages", description: "The kept tail is at least this many messages. Default 10.", default: 10 },
        tailBudgetFraction: { type: "number", title: "Tail-budget fraction", description: "Target size of the kept tail as a fraction of the effective budget. Default 0.20.", default: 0.2 },
        unrecoverableTools: { type: "string", title: "Unrecoverable tools", description: "Comma or newline separated list of tool names whose results must never be cleared." },
        model: { type: "string", title: "Summarizer model override", description: "Optional cheaper model id for the summarizer." },
        lockStalenessMs: { type: "number", title: "Lock staleness (ms)", description: "How long a summarization lock is honored. Default 600000 (10 min).", default: 600000 },
      },
    } as Record<string, unknown>,
  },
  hooks: {
    beforeRun: async (messages, ctx) => {
      const config = await getCompactionConfig();
      if (!config.enabled) {
        log("debug", ctx.conversationId, "beforeRun.skipped", { reason: "disabled" });
        return undefined;
      }

      log("debug", ctx.conversationId, "beforeRun.invoked", { messageCount: messages.length });

      try {
        const { compactChatMessages } = await import("@/lib/agent/compaction/v2");
        const compacted = await compactChatMessages(
          ctx.conversationId,
          "",
          messages as never,
          undefined,
        );
        if (compacted.length === 0) return undefined;
        const after = (compacted as unknown[]).length;
        if (after !== messages.length) {
          log("info", ctx.conversationId, "beforeRun.compacted", { before: messages.length, after });
        }
        return compacted as typeof messages;
      } catch (err) {
        log("warn", ctx.conversationId, "beforeRun.error", { error: (err as Error).message });
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
