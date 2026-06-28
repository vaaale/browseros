"use client";

import { useSyncExternalStore } from "react";
import { fsClient } from "@/lib/os-client";
import { trimToSettledTail } from "@/lib/agent/conversations-sanitize";

/**
 * Conversations live as one JSON file per chat under the user's VFS at
 * /Documents/Chats/<id>.json. Each file holds the metadata AND the message
 * history, so opening the app surfaces every prior conversation from disk and
 * messages survive reloads. The active conversation id is cached in
 * localStorage so we can focus the right thread immediately on mount.
 */

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
}

interface State {
  conversations: Conversation[];
  activeId: string;
  loaded: boolean;
}

export const CHATS_DIR = "/Documents/Chats";
const ACTIVE_KEY = "bos.activeConversation";
const DEFAULT_TITLE = "New conversation";
const SERVER_SNAPSHOT: State = {
  conversations: [{ id: "default", title: "Conversation", createdAt: 0 }],
  activeId: "default",
  loaded: false,
};

// Conversations currently awaiting an auto-title response — prevents firing
// duplicate requests while a generation is in flight.
const titleGenInFlight = new Set<string>();

function newId(): string {
  return "c-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function freshConversation(): Conversation {
  return { id: newId(), title: DEFAULT_TITLE, createdAt: Date.now() };
}

function chatPath(id: string): string {
  return `${CHATS_DIR}/${id}.json`;
}

interface ConversationFile {
  id: string;
  title: string;
  createdAt: number;
  // Plain AG-UI message objects ({ id, role, content, toolCalls? }); loaded
  // straight back into the chat agent by useChatPersistence.
  messages: unknown[];
}

async function readConversationFile(id: string): Promise<ConversationFile | null> {
  try {
    const content = await fsClient.read(chatPath(id));
    const parsed = JSON.parse(content) as ConversationFile;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      id: parsed.id ?? id,
      title: typeof parsed.title === "string" ? parsed.title : "Conversation",
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
    };
  } catch {
    return null;
  }
}

async function writeConversationFile(file: ConversationFile): Promise<void> {
  await fsClient.write(chatPath(file.id), JSON.stringify(file, null, 2));
}

let state: State | null = null;
let loadPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function readActiveId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

function persistActiveId(id: string): void {
  try {
    localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    /* ignore */
  }
}

async function loadFromVfs(): Promise<void> {
  let conversations: Conversation[] = [];
  try {
    await fsClient.mkdir(CHATS_DIR).catch(() => {});
    const entries = await fsClient.list(CHATS_DIR);
    const files = entries.filter((e) => e.type === "file" && e.name.endsWith(".json"));
    const loaded = await Promise.all(
      files.map(async (e) => {
        const id = e.name.replace(/\.json$/, "");
        const file = await readConversationFile(id);
        if (!file) return null;
        return { id: file.id, title: file.title, createdAt: file.createdAt };
      }),
    );
    conversations = loaded.filter((c): c is Conversation => c !== null);
    conversations.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    conversations = [];
  }

  if (conversations.length === 0) {
    const seed = freshConversation();
    conversations = [seed];
    try {
      await writeConversationFile({ ...seed, messages: [] });
    } catch {
      /* ignore — show the seed anyway, save will retry on next mutation */
    }
  }

  const storedActive = readActiveId();
  const activeId =
    storedActive && conversations.some((c) => c.id === storedActive)
      ? storedActive
      : conversations[0].id;
  persistActiveId(activeId);
  state = { conversations, activeId, loaded: true };
  notify();
}

function ensureLoading(): Promise<void> {
  if (!loadPromise) loadPromise = loadFromVfs();
  return loadPromise;
}

function get(): State {
  if (typeof window === "undefined") return SERVER_SNAPSHOT;
  if (!state) {
    void ensureLoading();
    return SERVER_SNAPSHOT;
  }
  return state;
}

function setState(next: State): void {
  state = next;
  notify();
}

export async function newConversation(): Promise<string> {
  await ensureLoading();
  const conv = freshConversation();
  const current = state ?? { conversations: [], activeId: "", loaded: true };
  persistActiveId(conv.id);
  setState({ conversations: [conv, ...current.conversations], activeId: conv.id, loaded: true });
  try {
    await writeConversationFile({ ...conv, messages: [] });
  } catch (err) {
    console.error("Failed to persist new conversation", err);
  }
  return conv.id;
}

export function selectConversation(id: string): void {
  const current = get();
  if (current.activeId === id) return;
  persistActiveId(id);
  setState({ ...current, activeId: id });
}

export async function deleteConversation(id: string): Promise<void> {
  await ensureLoading();
  const current = state ?? get();
  let conversations = current.conversations.filter((c) => c.id !== id);
  let activeId = current.activeId;
  if (conversations.length === 0) {
    const seed = freshConversation();
    conversations = [seed];
    activeId = seed.id;
    try {
      await writeConversationFile({ ...seed, messages: [] });
    } catch (err) {
      console.error("Failed to seed replacement conversation", err);
    }
  } else if (activeId === id) {
    activeId = conversations[0].id;
  }
  persistActiveId(activeId);
  setState({ conversations, activeId, loaded: true });
  try {
    await fsClient.remove(chatPath(id));
  } catch {
    /* file may not exist yet — ignore */
  }
}

export async function renameConversation(id: string, title: string): Promise<void> {
  const current = get();
  const conv = current.conversations.find((c) => c.id === id);
  if (!conv) return;
  const next = { ...conv, title };
  setState({
    ...current,
    conversations: current.conversations.map((c) => (c.id === id ? next : c)),
  });
  try {
    const file = (await readConversationFile(id)) ?? { ...next, messages: [] };
    await writeConversationFile({ ...file, title });
  } catch (err) {
    console.error("Failed to rename conversation file", err);
  }
}

/** Load the persisted messages for a conversation, trimmed to a settled tail so
 *  reopening it can never resume an in-flight turn (no uncommanded agent run). */
export async function loadConversationMessages(id: string): Promise<unknown[]> {
  const file = await readConversationFile(id);
  return trimToSettledTail(file?.messages ?? []);
}

/** Persist the messages of a conversation, preserving its metadata. */
export async function saveConversationMessages(id: string, messages: unknown[]): Promise<void> {
  const current = state;
  const meta = current?.conversations.find((c) => c.id === id);
  const existing = await readConversationFile(id);
  // Never replace an existing non-empty conversation with an empty message list:
  // an empty snapshot is a transient reset (thread swap / remount), not the user
  // clearing history. Dropping it here is the last line of defense against wipes.
  if (messages.length === 0 && existing && existing.messages.length > 0) return;
  // Prefer the in-memory title: renameConversation updates state synchronously
  // before writing to disk, so memory is always at least as fresh as disk and
  // a concurrent auto-title rename can't be clobbered by this save.
  const file: ConversationFile = {
    id,
    title: meta?.title ?? existing?.title ?? "Conversation",
    createdAt: existing?.createdAt ?? meta?.createdAt ?? Date.now(),
    messages,
  };
  await writeConversationFile(file);
  void maybeGenerateTitleInBackground(id, messages);
}

interface AnyMessage {
  role?: string;
  content?: unknown;
  toolCalls?: unknown[];
}

function readMessage(m: unknown): AnyMessage | null {
  return m && typeof m === "object" ? (m as AnyMessage) : null;
}

function firstUserText(messages: unknown[]): string | null {
  for (const m of messages) {
    const x = readMessage(m);
    if (x?.role === "user" && typeof x.content === "string" && x.content.trim().length > 0) {
      return x.content;
    }
  }
  return null;
}

function firstSettledAssistantText(messages: unknown[]): string | null {
  for (const m of messages) {
    const x = readMessage(m);
    if (x?.role !== "assistant") continue;
    const hasPendingCalls = Array.isArray(x.toolCalls) && x.toolCalls.length > 0;
    if (hasPendingCalls) continue;
    if (typeof x.content === "string" && x.content.trim().length > 0) return x.content;
  }
  return null;
}

/** Fire-and-forget background title generation, gated to once per conversation
 *  and only while the title is still the default placeholder. */
async function maybeGenerateTitleInBackground(id: string, messages: unknown[]): Promise<void> {
  if (titleGenInFlight.has(id)) return;
  const meta = state?.conversations.find((c) => c.id === id);
  if (!meta || meta.title !== DEFAULT_TITLE) return;
  const userText = firstUserText(messages);
  const assistantText = firstSettledAssistantText(messages);
  if (!userText || !assistantText) return;

  titleGenInFlight.add(id);
  try {
    const res = await fetch("/api/assistant/title", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userMessage: userText, assistantMessage: assistantText }),
    });
    if (!res.ok) return;
    const data = (await res.json()) as { title?: string };
    const title = data.title?.trim();
    if (!title) return;
    // Recheck — the user may have renamed the conversation manually while the
    // request was in flight; never overwrite a human-chosen title.
    const cur = state?.conversations.find((c) => c.id === id);
    if (!cur || cur.title !== DEFAULT_TITLE) return;
    await renameConversation(id, title);
  } catch {
    // Title generation is best-effort — failures are silent.
  } finally {
    titleGenInFlight.delete(id);
  }
}

export function useConversations(): State {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      void ensureLoading();
      return () => listeners.delete(cb);
    },
    () => get(),
    () => SERVER_SNAPSHOT,
  );
}

export function useActiveConversationId(): string {
  return useConversations().activeId;
}
