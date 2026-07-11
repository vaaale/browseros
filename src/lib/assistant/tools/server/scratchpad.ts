import "server-only";
import type { AssistantTool } from "../../tools";
import { serverTool, schema, p } from "./util";
import { deleteNote, editNote, readNotes, writeNote } from "@/lib/agent/scratchpad/handlers";
import { ensureInitialized } from "@/lib/agent/scratchpad/replay";
import { loadConversationMessages } from "../../conversation-store";

// Conversation-scoped scratchpad (ported from ScratchpadActions.tsx). Notes live
// in a per-conversation Map reconstructed by replaying the conversation's own
// persisted tool calls (ensureInitialized), so they survive reloads. Server-side
// the transcript loader is the v2 conversation store.
async function withInit<T>(conversationId: string, fn: (id: string) => T): Promise<T> {
  await ensureInitialized(conversationId, loadConversationMessages);
  return fn(conversationId);
}

export function scratchpadTools(): Record<string, AssistantTool> {
  return {
    scratchpad_write: serverTool(
      "scratchpad_write",
      "Create a new note in the conversation-scoped scratchpad. Titles must be unique within the conversation. Fails with NOTE_EXISTS if the title is taken — use scratchpad_edit to modify. Notes persist across reloads for the current conversation only.",
      schema({ title: p.str("Unique note title within this conversation."), content: p.str("Note body (any text; empty allowed).") }, ["title", "content"]),
      async (input, ctx) =>
        JSON.stringify(await withInit(ctx.conversationId, (id) => writeNote(id, String(input.title ?? ""), String(input.content ?? "")))),
    ),

    scratchpad_read: serverTool(
      "scratchpad_read",
      "Read scratchpad notes for the current conversation. With no title, returns metadata for every note. With a title, returns that note in full.",
      schema({ title: p.str("Optional: specific note title to fetch in full.") }),
      async (input, ctx) =>
        JSON.stringify(await withInit(ctx.conversationId, (id) => readNotes(id, input.title ? String(input.title) : undefined))),
    ),

    scratchpad_edit: serverTool(
      "scratchpad_edit",
      "Replace the content of an existing scratchpad note by title. Fails if the note does not exist.",
      schema({ title: p.str("Existing note title."), content: p.str("New note body.") }, ["title", "content"]),
      async (input, ctx) =>
        JSON.stringify(await withInit(ctx.conversationId, (id) => editNote(id, String(input.title ?? ""), String(input.content ?? "")))),
    ),

    scratchpad_delete: serverTool(
      "scratchpad_delete",
      "Delete a scratchpad note by title.",
      schema({ title: p.str("Note title to delete.") }, ["title"]),
      async (input, ctx) =>
        JSON.stringify(await withInit(ctx.conversationId, (id) => deleteNote(id, String(input.title ?? "")))),
    ),
  };
}
