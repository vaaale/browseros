// Reconstruct scratchpad state from conversation history. The persistent source
// of truth is the conversation's messages[] array (persisted at
// /Documents/Chats/<id>.json); on the first scratchpad tool call for a
// conversation we lazily walk that array, extract the prior scratchpad_* tool
// calls in order, and replay them into the in-memory Map. Subsequent calls hit
// the cached Map — no re-replay.

import { getNotes, isInitialized, markInitialized } from "./store";
import type { Note, ScratchpadOperation } from "./types";

const SCRATCHPAD_TOOL_NAMES = new Set(["scratchpad_write", "scratchpad_edit", "scratchpad_delete"]);

interface RawToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface RawMessage {
  id?: string;
  role?: string;
  content?: unknown;
  toolCalls?: unknown[];
  createdAt?: string | number;
}

function readMessage(m: unknown): RawMessage | null {
  return m && typeof m === "object" ? (m as RawMessage) : null;
}

function readToolCall(t: unknown): RawToolCall | null {
  return t && typeof t === "object" ? (t as RawToolCall) : null;
}

function parseArgs(raw: string | undefined): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function normalizeTimestamp(m: RawMessage, fallbackIndex: number): string {
  if (typeof m.createdAt === "string" && m.createdAt) return m.createdAt;
  if (typeof m.createdAt === "number" && Number.isFinite(m.createdAt)) {
    return new Date(m.createdAt).toISOString();
  }
  // Stable synthetic timestamp so replay is deterministic and `created`/`modified`
  // remain sortable when the history has no per-message timestamps.
  return new Date(0).toISOString().replace("1970-01-01T00:00:00.000Z", `1970-01-01T00:00:${String(fallbackIndex).padStart(2, "0")}.000Z`);
}

/**
 * Walk a raw messages[] array (as loaded from /Documents/Chats/<id>.json or from
 * CopilotKit's live agent.messages) and return the scratchpad operations in
 * order. Skips malformed tool calls silently — history is trusted, but the
 * feature must never crash on unexpected shapes.
 */
export function extractScratchpadOps(messages: unknown[]): ScratchpadOperation[] {
  if (!Array.isArray(messages)) return [];
  const ops: ScratchpadOperation[] = [];
  messages.forEach((msg, idx) => {
    const m = readMessage(msg);
    if (!m || !Array.isArray(m.toolCalls) || m.toolCalls.length === 0) return;
    const timestamp = normalizeTimestamp(m, idx);
    for (const raw of m.toolCalls) {
      const tc = readToolCall(raw);
      const name = tc?.function?.name;
      if (!name || !SCRATCHPAD_TOOL_NAMES.has(name)) continue;
      const args = parseArgs(tc?.function?.arguments);
      const title = typeof args?.title === "string" ? args.title : "";
      if (!title) continue;
      if (name === "scratchpad_write") {
        const content = typeof args?.content === "string" ? args.content : "";
        ops.push({ kind: "write", title, content, timestamp });
      } else if (name === "scratchpad_edit") {
        const content = typeof args?.content === "string" ? args.content : "";
        ops.push({ kind: "edit", title, content, timestamp });
      } else {
        ops.push({ kind: "delete", title, timestamp });
      }
    }
  });
  return ops;
}

function newNoteId(): string {
  return "n-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

/**
 * Apply an ordered list of operations to the conversation's notes Map. Edits or
 * deletes on notes that never existed are silently ignored — the history may
 * contain a failed attempt (e.g. NOTE_NOT_FOUND from a prior turn) which must
 * not cause replay to diverge from the actual on-disk record.
 */
export function replayOperations(conversationId: string, ops: ScratchpadOperation[]): void {
  const map = getNotes(conversationId);
  map.clear();
  for (const op of ops) {
    if (op.kind === "write") {
      const existing = map.get(op.title);
      const note: Note = existing
        ? { ...existing, content: op.content ?? "", modified: op.timestamp }
        : {
            id: newNoteId(),
            title: op.title,
            content: op.content ?? "",
            created: op.timestamp,
            modified: op.timestamp,
          };
      map.set(op.title, note);
    } else if (op.kind === "edit") {
      const existing = map.get(op.title);
      if (!existing) continue;
      map.set(op.title, { ...existing, content: op.content ?? "", modified: op.timestamp });
    } else {
      map.delete(op.title);
    }
  }
}

/**
 * Ensure the notes Map for `conversationId` is hydrated from history. Loads the
 * messages lazily via the injected reader (which the action wrapper points at
 * fsClient) and short-circuits once initialized. Missing/unreadable histories
 * count as "empty" — a valid state for a brand-new conversation.
 */
export async function ensureInitialized(
  conversationId: string,
  loadMessages: (id: string) => Promise<unknown[]>,
): Promise<void> {
  if (isInitialized(conversationId)) return;
  let messages: unknown[] = [];
  try {
    messages = (await loadMessages(conversationId)) ?? [];
  } catch {
    messages = [];
  }
  const ops = extractScratchpadOps(messages);
  replayOperations(conversationId, ops);
  markInitialized(conversationId);
}
