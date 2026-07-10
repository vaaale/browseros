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

/** The loop's IO facade for one conversation. */
export function conversationIO(conversationId: string, agentId: string): AgentLoopIO {
  return {
    loadMessages: () => loadConversationMessages(conversationId),
    saveMessages: (messages) => saveConversationMessages(conversationId, agentId, messages),
  };
}
