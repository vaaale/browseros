// Pure CRUD handlers over the in-memory scratchpad. These functions assume the
// caller has already ensured hydration (via ensureInitialized in replay.ts).
// They only touch the Map — persistence happens automatically because the
// action's tool call is recorded in the conversation's messages[].

import { deleteNoteFromStore, getNote, getNotes, setNote } from "./store";
import type { Note, NoteMetadata, ToolResult } from "./types";

function nowIso(): string {
  return new Date().toISOString();
}

function newNoteId(): string {
  return "n-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function validateTitle(title: unknown): { ok: true; title: string } | { ok: false; result: ToolResult } {
  if (typeof title !== "string" || title.trim().length === 0) {
    return {
      ok: false,
      result: { success: false, error: "INVALID_TITLE", message: "Title is required and must be a non-empty string." },
    };
  }
  return { ok: true, title: title.trim() };
}

function toMetadata(n: Note): NoteMetadata {
  return { id: n.id, title: n.title, created: n.created, modified: n.modified, size: n.content.length };
}

export function writeNote(conversationId: string, title: unknown, content: unknown): ToolResult {
  const t = validateTitle(title);
  if (!t.ok) return t.result;
  if (typeof content !== "string") {
    return { success: false, error: "VALIDATION_ERROR", message: "Content must be a string." };
  }
  if (getNote(conversationId, t.title)) {
    return {
      success: false,
      error: "NOTE_EXISTS",
      message: `A note titled "${t.title}" already exists. Use scratchpad_edit to change it.`,
    };
  }
  const stamp = nowIso();
  const note: Note = { id: newNoteId(), title: t.title, content, created: stamp, modified: stamp };
  setNote(conversationId, t.title, note);
  return { success: true, noteId: note.id, message: `Created note "${t.title}".` };
}

export function readNotes(conversationId: string, title?: unknown): ToolResult {
  if (title !== undefined && title !== null && title !== "") {
    const t = validateTitle(title);
    if (!t.ok) return t.result;
    const note = getNote(conversationId, t.title);
    if (!note) {
      return { success: false, error: "NOTE_NOT_FOUND", message: `No note titled "${t.title}".` };
    }
    return { success: true, note };
  }
  const all = Array.from(getNotes(conversationId).values()).map(toMetadata);
  return { success: true, notes: all, total: all.length };
}

export function editNote(conversationId: string, title: unknown, content: unknown): ToolResult {
  const t = validateTitle(title);
  if (!t.ok) return t.result;
  if (typeof content !== "string") {
    return { success: false, error: "VALIDATION_ERROR", message: "Content must be a string." };
  }
  const existing = getNote(conversationId, t.title);
  if (!existing) {
    return { success: false, error: "NOTE_NOT_FOUND", message: `No note titled "${t.title}".` };
  }
  setNote(conversationId, t.title, { ...existing, content, modified: nowIso() });
  return { success: true, message: `Updated note "${t.title}".` };
}

export function deleteNote(conversationId: string, title: unknown): ToolResult {
  const t = validateTitle(title);
  if (!t.ok) return t.result;
  if (!getNote(conversationId, t.title)) {
    return { success: false, error: "NOTE_NOT_FOUND", message: `No note titled "${t.title}".` };
  }
  deleteNoteFromStore(conversationId, t.title);
  return { success: true, message: `Deleted note "${t.title}".` };
}
