import "server-only";
import type { CompactionPrompt } from "./estimate";
import { estimateTokens } from "./estimate";
import type { Sidecar } from "./sidecar";
import { computeSpanHash } from "./sidecar";

// Pure view transformation on the model input array (spec 022 FR-004..012).
// No I/O, no clocks, no randomness — determinism is asserted by the byte-
// identity tests. The middleware handles all sidecar writes.

export interface CompactionView {
  clearThreshold: number;
  summarizeThreshold: number;
  hardLimit: number;
  keepToolResults: number;
  keepTailMessages: number;
  tailBudgetFraction: number;
  unrecoverableTools: string[];
}

export interface ApplyViewResult {
  messages: CompactionPrompt;
  transformed: boolean;
  stats: {
    estimatedTokens: number;
    budget: number;
    clearedResults: number;
    summarySpliced: boolean;
    droppedByBoundary: number;
  };
}

type Msg = CompactionPrompt[number];

function isAssistantMessage(m: Msg): m is Extract<Msg, { role: "assistant" }> {
  return m.role === "assistant";
}
function isToolMessage(m: Msg): m is Extract<Msg, { role: "tool" }> {
  return m.role === "tool";
}
function isUserMessage(m: Msg): m is Extract<Msg, { role: "user" }> {
  return m.role === "user";
}

/**
 * Walk backwards to find the "keep last N pairs" cut point: the message index
 * at or after which every tool-use/result pair is preserved. Everything before
 * (indices < result.cutIndex) is eligible for clearing.
 *
 * The cut lands on a **message boundary** (never mid-group): if the newest N
 * tool-call groups start at assistant index A, cutIndex = A.
 */
function findKeepPairsCut(messages: CompactionPrompt, keepN: number): number {
  if (keepN <= 0) return messages.length;
  let pairsSeen = 0;
  // Walk backwards; count each assistant message that contains tool-call parts.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!isAssistantMessage(m)) continue;
    if (m.content.some((p) => p.type === "tool-call")) {
      pairsSeen++;
      if (pairsSeen >= keepN) return i;
    }
  }
  return 0;
}

function placeholderText(toolName: string): string {
  return `<tool_result:${toolName}>output elided to save context — re-run the tool if the output is needed again</tool_result:${toolName}>`;
}

/** Replace a tool-result part with the one-line placeholder. Preserves the
 *  toolCallId + toolName so provider validation still passes. */
function clearedToolResultPart<T extends { type: "tool-result"; toolCallId: string; toolName: string; providerOptions?: unknown }>(part: T): T {
  return {
    ...part,
    output: { type: "text", value: placeholderText(part.toolName) },
  } as T;
}

/**
 * Layer 1: replace tool-result contents at positions older than the newest
 * `keepToolResults` pairs and older than the sidecar's clearWatermark with a
 * placeholder. Tool-call parts are preserved verbatim.
 *
 * Deterministic — same (messages, watermark, config) always yields the same
 * output, which is the SC-003 prompt-cache invariant.
 */
function applyLayer1Clearing(
  messages: CompactionPrompt,
  sidecar: Sidecar,
  config: CompactionView,
): { messages: CompactionPrompt; clearedResults: number } {
  const keepCut = findKeepPairsCut(messages, config.keepToolResults);
  const clearBefore = Math.max(sidecar.clearWatermark, keepCut);
  if (clearBefore <= 0) return { messages, clearedResults: 0 };
  const unrecoverable = new Set(config.unrecoverableTools);
  let cleared = 0;
  const out: CompactionPrompt = messages.map((m, idx) => {
    if (idx >= clearBefore) return m;
    if (isToolMessage(m)) {
      let mutated = false;
      const nextContent = m.content.map((p) => {
        if (p.type === "tool-result" && !unrecoverable.has(p.toolName)) {
          // Skip if already a placeholder (byte-identity between advances).
          if (p.output.type === "text" && p.output.value === placeholderText(p.toolName)) return p;
          mutated = true;
          cleared++;
          return clearedToolResultPart(p);
        }
        return p;
      });
      return mutated ? { ...m, content: nextContent } : m;
    }
    if (isAssistantMessage(m)) {
      let mutated = false;
      const nextContent = m.content.map((p) => {
        if (p.type === "tool-result" && !unrecoverable.has(p.toolName)) {
          if (p.output.type === "text" && p.output.value === placeholderText(p.toolName)) return p;
          mutated = true;
          cleared++;
          return clearedToolResultPart(p);
        }
        return p;
      });
      return mutated ? { ...m, content: nextContent } : m;
    }
    return m;
  });
  return { messages: out, clearedResults: cleared };
}

/**
 * Find the start index of the "kept tail":
 *   tail size = max(tailBudgetFraction × budget, minTailMessages)
 * then walk the cut back so (a) no tool group is split, and (b) the tail
 * begins at a user message (FR-008).
 *
 * A tool group is: an assistant message containing tool-call parts + the
 * following tool/assistant messages that resolve those tool_call ids.
 */
export function findTailStart(
  messages: CompactionPrompt,
  minTailMessages: number,
  tailBudgetFraction: number,
  budget: number,
): number {
  if (messages.length === 0) return 0;
  const tailTokenTarget = Math.floor(budget * tailBudgetFraction);
  // Grow the tail message-by-message until either the min message count or the
  // token target is reached.
  let cut = messages.length;
  let tailTokens = 0;
  while (cut > 0) {
    const takeMoreForMin = messages.length - cut < minTailMessages;
    const takeMoreForBudget = tailTokens < tailTokenTarget;
    if (!takeMoreForMin && !takeMoreForBudget) break;
    cut--;
    tailTokens += estimateTokens([messages[cut]]);
  }
  // Walk back so we don't split a tool group. A pending tool_call at the tail
  // start with no matching tool-result inside the tail means we've split.
  cut = walkBackPastPendingTools(messages, cut);
  // Walk back so the tail begins at a user message. If not user, step back one
  // more; repeat while inside a tool group.
  while (cut > 0 && !isUserMessage(messages[cut])) {
    cut--;
    cut = walkBackPastPendingTools(messages, cut);
  }
  return cut;
}

/** If the head of the kept tail (at `cut`) starts inside an unclosed tool
 *  group, walk `cut` further back until every tool-call at the boundary has its
 *  matching result inside the kept span. */
function walkBackPastPendingTools(messages: CompactionPrompt, cut: number): number {
  let i = cut;
  while (i > 0) {
    // Look for tool-result parts in the head of the tail that reference tool
    // calls not present in the kept span.
    const tailIds = new Set<string>();
    for (let j = i; j < messages.length; j++) {
      const m = messages[j];
      if (isAssistantMessage(m)) {
        for (const p of m.content) if (p.type === "tool-call") tailIds.add(p.toolCallId);
      }
    }
    let unresolved = false;
    for (let j = i; j < messages.length; j++) {
      const m = messages[j];
      if (isToolMessage(m)) {
        for (const p of m.content) if (p.type === "tool-result" && !tailIds.has(p.toolCallId)) { unresolved = true; break; }
      } else if (isAssistantMessage(m)) {
        for (const p of m.content) if (p.type === "tool-result" && !tailIds.has(p.toolCallId)) { unresolved = true; break; }
      }
      if (unresolved) break;
    }
    if (!unresolved) return i;
    i--;
  }
  return 0;
}

/** SUMMARY splice shape (FR-012): a single user-role message wrapping the
 *  summary in <conversation_summary>…</conversation_summary> with the fixed
 *  recovery note appended. Nothing else is inserted or reordered. */
export function buildSummaryMessage(summaryText: string): Extract<Msg, { role: "user" }> {
  const body = `<conversation_summary>\n${summaryText.trim()}\n\nEarlier details from this conversation were compacted. Durable lessons may be retrievable via memory_search.\n</conversation_summary>`;
  return { role: "user", content: [{ type: "text", text: body }] };
}

/** Predicate the middleware uses to decide whether to persist a fresh
 *  clearWatermark advance. */
export function shouldAdvanceClearWatermark(
  messages: CompactionPrompt,
  sidecar: Sidecar,
  config: CompactionView,
  budget: number,
): boolean {
  if (budget <= 0) return false;
  const est = estimateTokens(messages);
  if (est < Math.floor(budget * config.clearThreshold)) return false;
  const cut = findKeepPairsCut(messages, config.keepToolResults);
  return cut > sidecar.clearWatermark;
}

/**
 * Full view transform: applies the summary splice (Layer 2) when the sidecar
 * carries a valid summary + matching span hash, then Layer 1 tool-result
 * clearing on the kept tail.
 *
 * Below `clearThreshold * budget` this returns the input byte-identically
 * (SC-002).
 */
export function applyView(
  messages: CompactionPrompt,
  sidecar: Sidecar,
  config: CompactionView,
  budget: number,
): ApplyViewResult {
  const initialEst = estimateTokens(messages);
  const stats = {
    estimatedTokens: initialEst,
    budget,
    clearedResults: 0,
    summarySpliced: false,
    droppedByBoundary: 0,
  };
  const clearThresholdTokens = Math.floor(budget * config.clearThreshold);
  if (initialEst < clearThresholdTokens) {
    return { messages, transformed: false, stats };
  }

  // Step 1: splice the summary (Layer 2) if the sidecar carries one and its
  // span hash still matches the current message array up to boundary.count.
  let working: CompactionPrompt = messages;
  let dropped = 0;
  if (sidecar.summary && sidecar.boundary && sidecar.boundary.count > 0 && sidecar.boundary.count <= messages.length) {
    const span = messages.slice(0, sidecar.boundary.count);
    const currentHash = computeSpanHash(span);
    if (currentHash === sidecar.boundary.spanHash) {
      const kept = messages.slice(sidecar.boundary.count);
      // Ensure the kept tail begins at a user message (FR-008). In practice the
      // recorded boundary already lands on a user boundary; step forward one if
      // it doesn't (rare edge, e.g. after an intra-turn tool-loop step).
      let skip = 0;
      while (skip < kept.length && !isUserMessage(kept[skip])) skip++;
      const finalKept = skip > 0 ? kept.slice(skip) : kept;
      dropped = sidecar.boundary.count + skip;
      working = [buildSummaryMessage(sidecar.summary), ...finalKept];
      stats.summarySpliced = true;
      stats.droppedByBoundary = dropped;
    }
    // Hash-mismatch case is handled in the middleware (it clears the stale
    // summary from the sidecar and reschedules Layer 2).
  }

  // Step 2: Layer 1 clearing over the (possibly reduced) working set. The
  // clearWatermark is relative to the CURRENT working array's indices — when
  // the summary is spliced in, the watermark from the original array shifts by
  // `dropped - 1` (the single summary message replaces `dropped` originals).
  const effectiveSidecar: Sidecar =
    dropped > 0
      ? { ...sidecar, clearWatermark: Math.max(0, sidecar.clearWatermark - dropped + 1) }
      : sidecar;
  const layer1 = applyLayer1Clearing(working, effectiveSidecar, config);
  stats.clearedResults = layer1.clearedResults;

  return { messages: layer1.messages, transformed: true, stats };
}

/** Public helper used by the hard-limit fallback (Task 2.4): keep the first
 *  user message and the largest recent tail that fits inside the given target
 *  token budget. Pair-safe (via findTailStart / walkBackPastPendingTools). */
export function truncateToTail(
  messages: CompactionPrompt,
  config: CompactionView,
  targetTokens: number,
): CompactionPrompt {
  if (messages.length <= 1) return messages;
  const firstUserIdx = messages.findIndex((m) => m.role === "user");
  const first = firstUserIdx >= 0 ? messages[firstUserIdx] : null;
  const firstTokens = first ? estimateTokens([first]) : 0;
  const remaining = Math.max(0, targetTokens - firstTokens);
  const start = findTailStart(messages, 1, 1, remaining);
  const tail = messages.slice(Math.max(start, firstUserIdx + 1));
  return first ? [first, ...tail] : tail;
}
