"use client";

import { useEffect, useRef } from "react";
import { useCopilotAction } from "@copilotkit/react-core";
import { DEFAULT_AGENT_ID } from "@/lib/agent/agent-ids";
import { loadConversationMessages, useActiveConversationId } from "@/lib/agent/conversations";
import { deleteNote, editNote, readNotes, writeNote } from "@/lib/agent/scratchpad/handlers";
import { ensureInitialized } from "@/lib/agent/scratchpad/replay";
import type { ToolResult } from "@/lib/agent/scratchpad/types";

// Conversation-scoped note-taking exposed to the assistant. Notes live in a
// module-level Map keyed by conversationId (see src/lib/agent/scratchpad/); they
// survive page reloads because the tool calls themselves are persisted with the
// conversation. On the first tool call for a conversation we lazily replay its
// history to reconstruct the Map; subsequent calls hit the cache.
//
// The CopilotKit route gates these actions server-side via the unified
// capability allowlist, the same way as skill_*, workflow_*, etc.

export function ScratchpadActions({ agentId = DEFAULT_AGENT_ID }: { agentId?: string }) {
  // Read the CURRENT conversation through a ref so handlers never close over a
  // stale thread — mirrors the pattern in SubAgentActions.
  const conversationId = useActiveConversationId(agentId);
  const convIdRef = useRef(conversationId);
  useEffect(() => {
    convIdRef.current = conversationId;
  }, [conversationId]);

  async function withInit<T extends ToolResult>(fn: (id: string) => T): Promise<T> {
    const id = convIdRef.current;
    await ensureInitialized(id, loadConversationMessages);
    return fn(id);
  }

  useCopilotAction({
    name: "scratchpad_write",
    description:
      "Create a new note in the conversation-scoped scratchpad. Titles must be unique within the conversation. Fails with NOTE_EXISTS if the title is taken — use scratchpad_edit to modify an existing note. Notes persist across page reloads for the current conversation only.",
    parameters: [
      { name: "title", type: "string", description: "Unique note title within this conversation.", required: true },
      { name: "content", type: "string", description: "Note body (any text; empty string allowed).", required: true },
    ],
    handler: async ({ title, content }) => JSON.stringify(await withInit((id) => writeNote(id, title, content))),
  });

  useCopilotAction({
    name: "scratchpad_read",
    description:
      "Read scratchpad notes for the current conversation. With no title, returns metadata (title, timestamps, size) for every note. With a title, returns the full note including content.",
    parameters: [
      { name: "title", type: "string", description: "Optional: specific note title to fetch in full.", required: false },
    ],
    handler: async ({ title }) => JSON.stringify(await withInit((id) => readNotes(id, title))),
  });

  useCopilotAction({
    name: "scratchpad_edit",
    description:
      "Replace the content of an existing note. Fails with NOTE_NOT_FOUND if no note has that title. Refreshes the note's modified timestamp; created is preserved.",
    parameters: [
      { name: "title", type: "string", description: "Title of the note to update.", required: true },
      { name: "content", type: "string", description: "New note body (replaces the previous content).", required: true },
    ],
    handler: async ({ title, content }) => JSON.stringify(await withInit((id) => editNote(id, title, content))),
  });

  useCopilotAction({
    name: "scratchpad_delete",
    description:
      "Delete a note from the scratchpad. Immediate — no confirmation. Fails with NOTE_NOT_FOUND if the title is unknown.",
    parameters: [
      { name: "title", type: "string", description: "Title of the note to remove.", required: true },
    ],
    handler: async ({ title }) => JSON.stringify(await withInit((id) => deleteNote(id, title))),
  });

  return null;
}
