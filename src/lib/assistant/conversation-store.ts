import "server-only";
import * as vfs from "@/os/vfs";
import { enqueuePerKey } from "@/lib/agent/write-queue";
import { sanitizeLoadedMessages, normalizeMessages } from "@/lib/agent/conversations-sanitize";
import type { ChatMessage } from "./messages";
import type { AgentLoopIO } from "./agent-loop";

// Server-side single-writer conversation store. In v2 the agent loop is the
// ONLY writer of message history; every read-modify-write runs as a queued
// critical section per conversation id (same enqueuePerKey the client used),
// preserving file metadata (title, agentId, activeFeatureBranch, …) untouched.

const CHATS_DIR = "/Documents/Chats";

interface ConversationFile {
  id: string;
  title?: string;
  createdAt?: number;
  agentId?: string;
  group?: string;
  activeFeatureBranch?: string;
  messages: unknown[];
  [key: string]: unknown;
}

function pathFor(conversationId: string): string {
  return `${CHATS_DIR}/${conversationId}.json`;
}

async function readFile(conversationId: string): Promise<ConversationFile | undefined> {
  try {
    const raw = await vfs.readText(pathFor(conversationId));
    const parsed = JSON.parse(raw) as ConversationFile;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Load the sanitized transcript (empty for a missing/fresh conversation). */
export async function loadConversationMessages(conversationId: string): Promise<ChatMessage[]> {
  const file = await readFile(conversationId);
  const messages = Array.isArray(file?.messages) ? file.messages : [];
  return sanitizeLoadedMessages(messages) as ChatMessage[];
}

/** Replace the transcript, creating the file (with metadata) when missing. */
export async function saveConversationMessages(
  conversationId: string,
  agentId: string,
  messages: ChatMessage[],
): Promise<void> {
  await enqueuePerKey(conversationId, async () => {
    const existing = await readFile(conversationId);
    const file: ConversationFile = existing ?? {
      id: conversationId,
      title: "New conversation",
      createdAt: Date.now(),
      agentId,
      messages: [],
    };
    file.messages = normalizeMessages(messages);
    await vfs.mkdir(CHATS_DIR).catch(() => undefined);
    await vfs.writeText(pathFor(conversationId), JSON.stringify(file, null, 2));
  });
}

/**
 * Patch `activeFeatureBranch` on a conversation file, through the SAME
 * per-conversation queue as `saveConversationMessages`.
 *
 * This exists because the browser's own metadata edits (the chat header's
 * branch selector) used to persist via a plain, unserialized VFS write
 * (`/api/fs`'s generic `write` op) — a completely different code path from
 * this module's queue. The two writers raced: if the agent loop's next
 * message save (its `existing` read taken before the browser's write landed)
 * finished last, it wrote its own stale `activeFeatureBranch` back over the
 * user's clear, silently reverting it. Routing the edit through this queue
 * instead means both writers serialize against the SAME critical section for
 * a given conversation id, so whichever runs second always sees the other's
 * result rather than a stale snapshot.
 */
export async function setConversationActiveFeatureBranch(
  conversationId: string,
  branch: string | undefined,
): Promise<void> {
  await enqueuePerKey(conversationId, async () => {
    const existing = await readFile(conversationId);
    if (!existing) return; // nothing to patch — the conversation doesn't exist yet
    if (branch) existing.activeFeatureBranch = branch;
    else delete existing.activeFeatureBranch;
    await vfs.writeText(pathFor(conversationId), JSON.stringify(existing, null, 2));
  });
}

/** The loop's IO facade for one conversation. */
export function conversationIO(conversationId: string, agentId: string): AgentLoopIO {
  return {
    loadMessages: () => loadConversationMessages(conversationId),
    saveMessages: (messages) => saveConversationMessages(conversationId, agentId, messages),
  };
}
