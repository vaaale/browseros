import "server-only";
import { wrapLanguageModel, type LanguageModel } from "ai";
import type { LanguageModelV3, LanguageModelV3Middleware } from "@ai-sdk/provider";
import { logger } from "@/lib/logging";
import { hasCredentials } from "@/lib/agent/provider";
import { estimateTokens, estimateBudget, type CompactionPrompt } from "./estimate";
import {
  readSidecar,
  writeSidecar,
  computeSpanHash,
  emptySidecar,
  type Sidecar,
} from "./sidecar";
import {
  applyView,
  findTailStart,
  shouldAdvanceClearWatermark,
  truncateToTail,
  type CompactionView,
} from "./view";
import { readCompactionConfig, type CompactionConfig } from "./config";

// wrapLanguageModel middleware: the single choke point where compaction is
// applied to every model call (initial user turn + intra-turn tool-loop steps).
// The system prompt (params.system-equivalent — carried as an in-array
// system-role message by the AI SDK v6 conversion) is never mutated (FR-017).

const COMPONENT = "compaction";

function toViewConfig(cfg: CompactionConfig): CompactionView {
  return {
    clearThreshold: cfg.clearThreshold,
    summarizeThreshold: cfg.summarizeThreshold,
    hardLimit: cfg.hardLimit,
    keepToolResults: cfg.keepToolResults,
    keepTailMessages: cfg.keepTailMessages,
    tailBudgetFraction: cfg.tailBudgetFraction,
    unrecoverableTools: cfg.unrecoverableTools,
  };
}

/** Log helper that keeps `conversation` at the top level of the record and
 *  the compaction-specific payload in `data`. */
function log(level: "debug" | "info" | "warn" | "error", convId: string, msg: string, data?: Record<string, unknown>, err?: unknown): void {
  logger().log({
    level,
    component: COMPONENT,
    conversation: convId,
    msg,
    ...(data ? { data } : {}),
    ...(err ? { err: err instanceof Error ? { message: err.message, ...(err.stack ? { stack: err.stack } : {}) } : { message: String(err) } } : {}),
  });
}

/** Provider-timing log. Uses the "assistant" component (not "compaction") so it
 *  groups with the conversation turn logs, and keeps `conversation` at top level
 *  so the Settings→Log conversation filter picks it up. */
function providerLog(level: "info" | "warn", convId: string, msg: string, data?: Record<string, unknown>, err?: unknown): void {
  logger().log({
    level,
    component: "assistant",
    conversation: convId,
    msg,
    ...(data ? { data } : {}),
    ...(err ? { err: err instanceof Error ? { message: err.message, ...(err.stack ? { stack: err.stack } : {}) } : { message: String(err) } } : {}),
  });
}

function extractPromptMessages(prompt: unknown): CompactionPrompt | null {
  if (!Array.isArray(prompt)) return null;
  return prompt as CompactionPrompt;
}

/** Split the leading system-role messages (which the AI SDK v6 v3 conversion
 *  places at the head of the prompt) from the user/assistant/tool sequence.
 *  The system prefix is passed through untouched (FR-017). */
function splitSystemPrefix(messages: CompactionPrompt): { system: CompactionPrompt; rest: CompactionPrompt } {
  let i = 0;
  while (i < messages.length && messages[i].role === "system") i++;
  return { system: messages.slice(0, i), rest: messages.slice(i) };
}

async function schedulePersistedWatermark(
  convId: string,
  current: Sidecar | null,
  rest: CompactionPrompt,
  config: CompactionView,
  budget: number,
): Promise<void> {
  const base = current ?? emptySidecar();
  if (!shouldAdvanceClearWatermark(rest, base, config, budget)) return;
  // The new watermark is the "keep last N pairs" cut over the current message
  // set: everything strictly before it is safe to placeholder.
  let cut = 0;
  let pairs = 0;
  for (let idx = rest.length - 1; idx >= 0; idx--) {
    const m = rest[idx];
    if (m.role === "assistant" && m.content.some((p) => p.type === "tool-call")) {
      pairs++;
      if (pairs >= config.keepToolResults) {
        cut = idx;
        break;
      }
    }
  }
  const next: Sidecar = { ...base, clearWatermark: Math.max(base.clearWatermark, cut) };
  try {
    await writeSidecar(convId, next);
    log("info", convId, "clear.advance", { clearWatermark: next.clearWatermark, previous: base.clearWatermark });
  } catch (err) {
    log("error", convId, "sidecar.write failed", undefined, err);
  }
}

async function maybeInvalidateStaleSummary(
  convId: string,
  sidecar: Sidecar,
  messages: CompactionPrompt,
): Promise<Sidecar> {
  if (!sidecar.boundary || !sidecar.summary) return sidecar;
  if (sidecar.boundary.count > messages.length) {
    // Client truncated history — always a mismatch.
    log("info", convId, "hash.invalidated", { previous: sidecar.boundary.spanHash, reason: "boundary-past-end" });
    const next: Sidecar = { ...sidecar, boundary: null, summary: null };
    try { await writeSidecar(convId, next); } catch (err) { log("error", convId, "sidecar.write failed", undefined, err); }
    return next;
  }
  const currentHash = computeSpanHash(messages.slice(0, sidecar.boundary.count));
  if (currentHash === sidecar.boundary.spanHash) return sidecar;
  log("info", convId, "hash.invalidated", {
    previous: sidecar.boundary.spanHash,
    current: currentHash,
  });
  const next: Sidecar = { ...sidecar, boundary: null, summary: null };
  try { await writeSidecar(convId, next); } catch (err) { log("error", convId, "sidecar.write failed", undefined, err); }
  return next;
}

async function scheduleSummarization(convId: string): Promise<void> {
  try {
    // Dynamic import so Phase-1 builds work before summarize.ts lands, and so
    // the summarizer module (which pulls in the LLM stack) is only loaded when
    // actually needed.
    const mod = (await import("./summarize")) as {
      summarizeConversation?: (id: string, opts: { manual: boolean }) => Promise<unknown>;
    };
    if (!mod.summarizeConversation) return;
    void mod
      .summarizeConversation(convId, { manual: false })
      .catch((err: unknown) => log("error", convId, "summarize failed", undefined, err));
    log("info", convId, "summary.scheduled");
  } catch (err) {
    log("error", convId, "summarize import failed", undefined, err);
  }
}

/**
 * Total function: never throws to the caller. On any unexpected error, logs
 * and returns the input params byte-identically so the model call proceeds.
 */
async function transformCall(convId: string, params: { prompt: unknown; maxOutputTokens?: number }): Promise<{ prompt?: unknown }> {
  const messages = extractPromptMessages(params.prompt);
  if (!messages || messages.length === 0) return {};
  let config: CompactionConfig;
  try {
    config = await readCompactionConfig();
  } catch (err) {
    log("error", convId, "config.read failed", undefined, err);
    return {};
  }
  if (!config.enabled) return {};
  const viewConfig = toViewConfig(config);
  const budget = estimateBudget({
    maxInputTokens: undefined,
    maxTokens: params.maxOutputTokens,
    assumedContextTokens: config.assumedContextTokens,
  });
  if (budget <= 0) return {};

  const { system, rest } = splitSystemPrefix(messages);
  const initialEst = estimateTokens(rest);
  const clearThresholdTokens = Math.floor(budget * viewConfig.clearThreshold);
  if (initialEst < clearThresholdTokens) return {};

  const initialSidecar = (await readSidecar(convId)) ?? emptySidecar();
  const sidecar = await maybeInvalidateStaleSummary(convId, initialSidecar, rest);

  const applied = applyView(rest, sidecar, viewConfig, budget);
  let finalRest: CompactionPrompt = applied.messages;

  // Advance clearWatermark asynchronously (fire-and-forget).
  void schedulePersistedWatermark(convId, sidecar, rest, viewConfig, budget);

  // Recompute the estimate on the transformed rest.
  const layerOneEst = estimateTokens(finalRest);
  const summarizeThresholdTokens = Math.floor(budget * viewConfig.summarizeThreshold);
  const hardLimitTokens = Math.floor(budget * viewConfig.hardLimit);

  // Schedule Layer 2 when past summarizeThreshold and no valid summary is present.
  // Task 3.4: skip Layer 2 entirely if no provider credentials are configured.
  const canSummarize = await hasCredentials().catch(() => false);
  if (
    canSummarize &&
    layerOneEst >= summarizeThresholdTokens &&
    !applied.stats.summarySpliced
  ) {
    void scheduleSummarization(convId);
  }

  // Layer 3: hard-limit fallback. This is synchronous — we cannot let the
  // provider see a prompt over budget (SC-005).
  if (layerOneEst >= hardLimitTokens) {
    const target = Math.max(1, Math.floor(budget * viewConfig.summarizeThreshold));
    const truncated = truncateToTail(finalRest, viewConfig, target);
    const afterEst = estimateTokens(truncated);
    log("warn", convId, "fallback.applied", {
      est: layerOneEst,
      afterEst,
      budget,
      messagesBefore: finalRest.length,
      messagesAfter: truncated.length,
    });
    finalRest = truncated;
    // Still schedule Layer 2 so the next turn benefits from a real summary.
    if (canSummarize && !applied.stats.summarySpliced) void scheduleSummarization(convId);
  }

  if (finalRest === rest) return {};
  const nextPrompt = [...system, ...finalRest];
  log("info", convId, "compaction.applied", {
    estBefore: initialEst,
    estAfter: estimateTokens(finalRest),
    budget,
    clearedResults: applied.stats.clearedResults,
    summarySpliced: applied.stats.summarySpliced,
    droppedByBoundary: applied.stats.droppedByBoundary,
    hardLimitFallback: layerOneEst >= hardLimitTokens,
    messagesBefore: rest.length,
    messagesAfter: finalRest.length,
  });
  return { prompt: nextPrompt };
}

function isWrappableModel(m: unknown): m is LanguageModelV3 {
  if (!m || typeof m !== "object") return false;
  const cand = m as { specificationVersion?: unknown; doGenerate?: unknown };
  return cand.specificationVersion === "v3" && typeof cand.doGenerate === "function";
}

/** Wrap an AI-SDK v6 language model with the compaction middleware. Non-V3
 *  models (e.g. a raw provider-model-id string) fall through unchanged so the
 *  request pipeline is unaffected. Requests without a conv id should not wrap
 *  at all — the caller handles that guard. */
export function withCompaction(model: LanguageModel, convId: string): LanguageModel {
  if (!isWrappableModel(model)) return model;
  const middleware: LanguageModelV3Middleware = {
    specificationVersion: "v3",
    transformParams: async ({ params }) => {
      try {
        const patch = await transformCall(convId, params as { prompt: unknown; maxOutputTokens?: number });
        if (patch.prompt === undefined) return params;
        return { ...params, prompt: patch.prompt } as typeof params;
      } catch (err) {
        log("error", convId, "middleware.error", undefined, err);
        return params;
      }
    },
    // Provider-call timing. Every model call (the first user turn AND each
    // intra-turn tool-loop continuation) passes through here, so this is where a
    // "the tool finished but nothing happens for minutes" stall is measurable:
    // it records time-to-first-chunk and total duration of the actual provider
    // request. A large TTFB after a tool result means the provider is slow on
    // the grown context, not a client-side hang.
    wrapStream: async ({ doStream }) => {
      const t0 = Date.now();
      providerLog("info", convId, "provider.request", { mode: "stream" });
      const { stream, ...rest } = await doStream();
      let first = true;
      let chunks = 0;
      const monitor = new TransformStream({
        transform(chunk, controller) {
          if (first) {
            first = false;
            providerLog("info", convId, "provider.first-chunk", { ttfbMs: Date.now() - t0 });
          }
          chunks++;
          controller.enqueue(chunk);
        },
        flush() {
          providerLog("info", convId, "provider.done", { totalMs: Date.now() - t0, chunks });
        },
      });
      return { stream: stream.pipeThrough(monitor), ...rest };
    },
    wrapGenerate: async ({ doGenerate }) => {
      const t0 = Date.now();
      providerLog("info", convId, "provider.request", { mode: "generate" });
      try {
        const r = await doGenerate();
        providerLog("info", convId, "provider.done", { totalMs: Date.now() - t0, mode: "generate" });
        return r;
      } catch (err) {
        providerLog("warn", convId, "provider.failed", { totalMs: Date.now() - t0 }, err);
        throw err;
      }
    },
  };
  return wrapLanguageModel({ model, middleware });
}

// Exposed for the API route + tests.
export { findTailStart };
