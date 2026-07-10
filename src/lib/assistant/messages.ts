// The persisted chat message contract (framework-free — client, server, tests).
// This is the SAME shape historical conversations already use on disk
// (/Documents/Chats/<id>.json), so v2 renders old history unchanged and the
// thumbs/fast-loop integrations keep working.

export interface ToolCallRef {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content?: string;
  toolCalls?: ToolCallRef[];
  /** role:"tool" only — the assistant toolCall this message answers. */
  toolCallId?: string;
  /** Thumbs feedback stamped by the UI; consumed by the memory fast loop. */
  feedback?: { rating: "up" | "down"; at: number };
}

export function newMessageId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `m-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Index of the last user message, or -1. */
export function lastUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return i;
  }
  return -1;
}

/** Truncate the history for an edit-resubmit: drop `messageId` (which must be
 *  the LAST user message) and everything after it. Throws when the id does not
 *  identify the last user message — the route surfaces this as a 409. */
export function truncateForEdit(messages: ChatMessage[], messageId: string): ChatMessage[] {
  const idx = lastUserIndex(messages);
  if (idx === -1 || messages[idx].id !== messageId) {
    throw new Error(`Message ${messageId} is not the last user message; cannot edit-resubmit.`);
  }
  return messages.slice(0, idx);
}

/** Tool ids revealed by prior find_tools results in THIS conversation (025).
 *  Derived statelessly from the transcript, mirroring tool-gate.ts, but over
 *  the persisted message shape. */
export function deriveRevealedIds(messages: ChatMessage[]): Set<string> {
  const callNames = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.toolCalls)) continue;
    for (const tc of m.toolCalls) {
      if (tc?.id && tc.function?.name) callNames.set(tc.id, tc.function.name);
    }
  }
  const revealed = new Set<string>();
  for (const m of messages) {
    if (m.role !== "tool" || !m.toolCallId) continue;
    if (callNames.get(m.toolCallId) !== "find_tools") continue;
    try {
      const payload = JSON.parse(m.content ?? "");
      if (!Array.isArray(payload)) continue;
      for (const r of payload) {
        const id = (r as { id?: unknown })?.id;
        if (typeof id === "string" && id) revealed.add(id);
      }
    } catch {
      /* malformed find_tools payload — skip */
    }
  }
  return revealed;
}
