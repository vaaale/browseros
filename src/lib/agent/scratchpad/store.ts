// Module-level scratchpad state, keyed by conversationId. Each conversation
// gets its own inner Map<title, Note>. State is derived from the conversation
// history via replay.ts (called lazily on first tool call); this module is a
// pure in-memory cache and knows nothing about how state got there.

import type { Note } from "./types";

type NotesByTitle = Map<string, Note>;

const store = new Map<string, NotesByTitle>();

// Tracks which conversations have already been hydrated from history. Kept
// separate from `store` because an empty Map is a legitimate initialized state
// (conversation with no scratchpad ops yet) — we must not re-replay it.
const initialized = new Set<string>();

/**
 * Get (or create) the notes Map for a conversation. Does NOT trigger replay;
 * callers who need hydration must go through `ensureInitialized` in replay.ts
 * first. Returns the same Map instance on every call for a given id.
 */
export function getNotes(conversationId: string): NotesByTitle {
  let m = store.get(conversationId);
  if (!m) {
    m = new Map();
    store.set(conversationId, m);
  }
  return m;
}

export function getNote(conversationId: string, title: string): Note | undefined {
  return getNotes(conversationId).get(title);
}

export function setNote(conversationId: string, title: string, note: Note): void {
  getNotes(conversationId).set(title, note);
}

export function deleteNoteFromStore(conversationId: string, title: string): boolean {
  return getNotes(conversationId).delete(title);
}

export function isInitialized(conversationId: string): boolean {
  return initialized.has(conversationId);
}

export function markInitialized(conversationId: string): void {
  initialized.add(conversationId);
}

// Test-only: drop all cached state (both the notes Maps and the initialization
// tracking) so unit tests start from a clean slate.
export function resetScratchpadForTests(): void {
  store.clear();
  initialized.clear();
}
