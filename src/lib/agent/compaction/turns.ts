import "server-only";
import type { ChatMessage } from "@/lib/assistant/messages";
import { estimateChatTokens } from "./estimate";

// Turn-boundary helpers, native to ChatMessage[]. A "turn" = one user message
// through (not including) the next user message — the same atomic unit used
// throughout the compaction redesign (blocks, eviction, the live tail), so
// every layer aligns to the same cuts and a tool-call/result pair is never
// split (tool messages never start a turn).

/** Indices where each turn begins (each is a "user"-role message), ascending. */
export function turnStarts(messages: ChatMessage[]): number[] {
  const starts: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") starts.push(i);
  }
  return starts;
}

/** The id of the first user message in the transcript — the "original
 *  intent," re-derived fresh every call rather than persisted. Safe: edit-
 *  resubmit only ever truncates the newest turn onward, so the only way the
 *  first turn changes is the user editing it away, at which point the new
 *  first message is correctly the new pinned intent. */
export function firstUserMessageId(messages: ChatMessage[]): string | undefined {
  return messages.find((m) => m.role === "user")?.id;
}

/** Ids of every message inside a "protected" turn: the first turn (original
 *  intent — pinned in full, not just its user message, so an assistant reply/
 *  tool-call from that turn never silently vanishes into a later block), plus
 *  any turn containing a call to a tool in `unrecoverableTools`. Protected
 *  turns are never placeholdered (Layer 1) or grouped into a block (Layer 2). */
export function protectedTurnMessageIds(messages: ChatMessage[], unrecoverableTools: string[]): Set<string> {
  const protectedIds = new Set<string>();
  const starts = turnStarts(messages);
  if (starts.length === 0) return protectedIds;
  const unrecoverable = new Set(unrecoverableTools);
  for (let t = 0; t < starts.length; t++) {
    const from = starts[t];
    const to = t + 1 < starts.length ? starts[t + 1] : messages.length;
    const turnMsgs = messages.slice(from, to);
    const isFirstTurn = t === 0;
    const hasUnrecoverableCall =
      unrecoverable.size > 0 &&
      turnMsgs.some((m) => m.role === "assistant" && (m.toolCalls ?? []).some((tc) => unrecoverable.has(tc.function.name)));
    if (isFirstTurn || hasUnrecoverableCall) {
      for (const m of turnMsgs) protectedIds.add(m.id);
    }
  }
  return protectedIds;
}

/** Map every assistant tool-call id to its tool name, so a role:"tool" result
 *  message (which only carries a toolCallId) can be resolved back to what
 *  tool produced it. */
export function buildToolNameIndex(messages: ChatMessage[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const tc of m.toolCalls ?? []) index.set(tc.id, tc.function.name);
  }
  return index;
}

/** Layer 1's recency window: the message index at/after which every tool-
 *  call/result pair is preserved verbatim. Everything before is eligible for
 *  clearing. Counts backwards by assistant messages carrying tool calls
 *  (ported from view.ts's findKeepPairsCut). */
export function findKeepPairsCutIndex(messages: ChatMessage[], keepN: number): number {
  if (keepN <= 0) return messages.length;
  let pairsSeen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant" || !m.toolCalls?.length) continue;
    pairsSeen++;
    if (pairsSeen >= keepN) return i;
  }
  return 0;
}

/** The start index of the live, always-verbatim tail: grows backwards turn by
 *  turn while EITHER the minimum turn count OR the token budget target still
 *  wants more (same "whichever is larger" rule as the old findTailStart), then
 *  lands on the resulting turn boundary. Turns are inherently tool-group-safe
 *  (a tool message never starts a turn), so no separate pair-realignment walk
 *  is needed the way the old message-granularity version required. */
export function findTailCutIndex(
  messages: ChatMessage[],
  keepTailTurns: number,
  tailBudgetFraction: number,
  budget: number,
): number {
  const starts = turnStarts(messages);
  if (starts.length === 0) return 0;
  const tailTokenTarget = Math.floor(budget * tailBudgetFraction);
  let turnsTaken = 0;
  let tailTokens = 0;
  let cutTurn = starts.length;
  for (let t = starts.length - 1; t >= 0; t--) {
    const takeMoreForMin = turnsTaken < keepTailTurns;
    const takeMoreForBudget = tailTokens < tailTokenTarget;
    if (!takeMoreForMin && !takeMoreForBudget) break;
    const from = starts[t];
    const to = t + 1 < starts.length ? starts[t + 1] : messages.length;
    tailTokens += estimateChatTokens("", messages.slice(from, to));
    turnsTaken++;
    cutTurn = t;
  }
  return cutTurn < starts.length ? starts[cutTurn] : messages.length;
}
