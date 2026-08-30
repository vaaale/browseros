import "server-only";
import type { ChatMessage } from "@/lib/assistant/messages";
import { logger } from "@/lib/logging";
import { hasCredentials } from "@/lib/agent/provider";
import { readCompactionConfig, type CompactionConfig } from "./config";
import { estimateChatTokens, estimateBudget } from "./estimate";
import { readSidecar, emptySidecar } from "./sidecar";
import { renderView } from "./render";
import { truncateChatTail, forceClearAll } from "./truncate";

// v2 compaction entry point: the ONLY caller (src/lib/assistant/model-turn.ts)
// feeds the provider directly, so this operates natively on ChatMessage[] —
// no AI-SDK v3 prompt intermediate (that conversion, and the raw ai-sdk
// `withCompaction()` LanguageModel-wrapping path it existed for, are gone;
// nothing in the live app reaches that path anymore). The result is EPHEMERAL:
// it feeds one provider call only and is never persisted (the loop persists
// the original, uncompacted transcript).

const COMPONENT = "compaction";

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

async function scheduleBlockFormation(convId: string): Promise<void> {
  try {
    // Dynamic import so the summarizer module (which pulls in the LLM stack)
    // is only loaded when actually needed.
    const mod = (await import("./summarize")) as {
      formNewBlocks?: (id: string, opts: { manual: boolean }) => Promise<unknown>;
    };
    if (!mod.formNewBlocks) return;
    void mod.formNewBlocks(convId, { manual: false }).catch((err: unknown) => log("error", convId, "blocks.form failed", undefined, err));
    log("info", convId, "blocks.scheduled");
  } catch (err) {
    log("error", convId, "blocks.import failed", undefined, err);
  }
}

/** Compact a v2 transcript for one provider call. Returns the input unchanged
 *  when compaction is disabled / below threshold / errors. Never throws. */
export async function compactChatMessages(
  convId: string,
  system: string,
  messages: ChatMessage[],
  maxOutputTokens?: number,
  maxInputTokens?: number,
): Promise<ChatMessage[]> {
  if (!convId || messages.length === 0) return messages;

  let config: CompactionConfig;
  try {
    config = await readCompactionConfig();
  } catch (err) {
    log("error", convId, "config.read failed", undefined, err);
    return messages;
  }
  if (!config.enabled) return messages;

  const budget = estimateBudget({ maxTokens: maxOutputTokens, maxInputTokens, assumedContextTokens: config.assumedContextTokens });
  if (budget <= 0) {
    log("warn", convId, "budget.exhausted", { maxOutputTokens, maxInputTokens, assumedContextTokens: config.assumedContextTokens });
    return messages;
  }

  const initialEst = estimateChatTokens(system, messages);
  const clearThresholdTokens = Math.floor(budget * config.clearThreshold);
  if (initialEst < clearThresholdTokens) return messages;

  try {
    const sidecar = (await readSidecar(convId)) ?? emptySidecar();
    const rendered = renderView(messages, sidecar, { keepToolResults: config.keepToolResults, unrecoverableTools: config.unrecoverableTools });
    let finalMessages = rendered.messages;

    const layerOneEst = estimateChatTokens(system, finalMessages);
    const summarizeThresholdTokens = Math.floor(budget * config.summarizeThreshold);
    const hardLimitTokens = Math.floor(budget * config.hardLimit);

    const canSummarize = await hasCredentials().catch(() => false);
    if (canSummarize && layerOneEst >= summarizeThresholdTokens) {
      void scheduleBlockFormation(convId);
    }

    // Layer 3: hard-limit fallback. Synchronous — a prompt over budget must
    // never reach the provider. Single pass then truncate, no recursion: if
    // truncating still isn't enough, one emergency force-clear pass, then
    // whatever that yields is sent — block formation (Layer 2/2b) never runs
    // synchronously inline here, only ever scheduled for the next render.
    if (layerOneEst >= hardLimitTokens) {
      const target = Math.max(1, Math.floor(budget * config.summarizeThreshold));
      let truncated = truncateChatTail(finalMessages, config.keepTailTurns, target);
      let afterEst = estimateChatTokens(system, truncated);

      let forceCleared = 0;
      if (afterEst >= hardLimitTokens) {
        const result = forceClearAll(truncated, config.unrecoverableTools);
        forceCleared = result.cleared;
        truncated = result.messages;
        afterEst = estimateChatTokens(system, truncated);
      }

      log(afterEst >= hardLimitTokens ? "error" : "warn", convId, "fallback.applied", {
        est: layerOneEst,
        afterEst,
        budget,
        messagesBefore: finalMessages.length,
        messagesAfter: truncated.length,
        ...(forceCleared > 0 ? { forceCleared, overBudget: afterEst >= hardLimitTokens } : {}),
      });
      finalMessages = truncated;
      if (canSummarize) void scheduleBlockFormation(convId);
    }

    log("info", convId, "compaction.applied", {
      estBefore: initialEst,
      estAfter: estimateChatTokens(system, finalMessages),
      budget,
      clearedResults: rendered.stats.clearedResults,
      blocksRendered: rendered.stats.blocksRendered,
      hardLimitFallback: layerOneEst >= hardLimitTokens,
      messagesBefore: messages.length,
      messagesAfter: finalMessages.length,
    });
    return finalMessages;
  } catch (err) {
    log("error", convId, "compactChatMessages.error", undefined, err);
    return messages;
  }
}
