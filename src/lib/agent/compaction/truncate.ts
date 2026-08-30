import type { ChatMessage } from "@/lib/assistant/messages";
import { estimateChatTokens } from "./estimate";
import { findTailCutIndex, protectedTurnMessageIds } from "./turns";
import { computeLayer1Placeholders } from "./render";

// Layer 3: the synchronous hard-limit fallback. Pure — split out of v2.ts so
// it (and its pair-completeness/pinned-turn-awareness invariants) can be unit
// tested without pulling in v2.ts's heavier imports (config/logging).

/** Keep the first user message + the largest recent tail that fits
 *  `targetTokens`. Pair-safe by construction — findTailCutIndex only ever
 *  cuts at turn boundaries, so a tool-call/result pair is never split. */
export function truncateChatTail(messages: ChatMessage[], keepTailTurns: number, targetTokens: number): ChatMessage[] {
  if (messages.length <= 1) return messages;
  const firstUserIdx = messages.findIndex((m) => m.role === "user");
  const first = firstUserIdx >= 0 ? messages[firstUserIdx] : null;
  const firstTokens = first ? estimateChatTokens("", [first]) : 0;
  const remaining = Math.max(0, targetTokens - firstTokens);
  const start = findTailCutIndex(messages, keepTailTurns, 1, remaining);
  const tail = messages.slice(Math.max(start, firstUserIdx + 1));
  return first ? [first, ...tail] : tail;
}

/** Emergency second pass when truncation alone still doesn't fit (e.g. one
 *  oversized tool result inside the kept tail): force-placeholder every tool
 *  result, including the normally-protected recent ones — but
 *  `unrecoverableTools` protection still applies even here. */
export function forceClearAll(messages: ChatMessage[], unrecoverableTools: string[]): { messages: ChatMessage[]; cleared: number } {
  const protectedIds = protectedTurnMessageIds(messages, unrecoverableTools);
  const placeholders = computeLayer1Placeholders(messages, { keepToolResults: 0, unrecoverableTools }, {}, protectedIds);
  let cleared = 0;
  const out = messages.map((m) => {
    const ph = placeholders.get(m.id);
    if (ph === undefined) return m;
    cleared++;
    return { ...m, content: ph };
  });
  return { messages: out, cleared };
}
