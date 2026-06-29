"use client";

import { useSyncExternalStore } from "react";
import { fsClient } from "@/lib/os-client";
import { trimToSettledTail } from "@/lib/agent/conversations-sanitize";

/**
 * Conversations live as one JSON file per chat under the user's VFS at
 * /Documents/Chats/<id>.json. Each file holds metadata AND message history.
 *
 * Conversations are partitioned into GROUPS (012-embeddable-assistant): the
 * Assistant app uses the default "assistant" group; an embedded chat (e.g. Build
 * Studio) uses its own group and only sees its group's conversations. The group is
 * a field on each conversation (files without one default to "assistant", so older
 * chats migrate transparently). The active conversation id is tracked PER GROUP in
 * localStorage. All public APIs default to the "assistant" group, so existing
 * callers are unaffected.
 */

export const DEFAULT_GROUP = "assistant";

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  group: string;
  // Per-conversation agent (personality). Optional for back-compat: pre-existing
  // chats have no agentId and fall back to the group's agent (for embeds) or the
  // globally active agent (for the Assistant app).
  agentId?: string;
}

interface State {
  conversations: Conversation[]; // across all groups
  activeByGroup: Record<string, string>;
  loaded: boolean;
}

export const CHATS_DIR = "/Documents/Chats";
const ACTIVE_KEY_PREFIX = "bos.activeConversation.";
const DEFAULT_TITLE = "New conversation";
const SERVER_SNAPSHOT: State = { conversations: [], activeByGroup: {}, loaded: false };

const titleGenInFlight = new Set<string>();

function newId(): string {
  return "c-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function freshConversation(group: string, agentId?: string): Conversation {
  return { id: newId(), title: DEFAULT_TITLE, createdAt: Date.now(), group, agentId };
}

function chatPath(id: string): string {
  return `${CHATS_DIR}/${id}.json`;
}

interface ConversationFile {
  id: string;
  title: string;
  createdAt: number;
  group: string;
  agentId?: string;
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
      group: typeof parsed.group === "string" && parsed.group ? parsed.group : DEFAULT_GROUP,
      agentId: typeof parsed.agentId === "string" && parsed.agentId ? parsed.agentId : undefined,
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

function readActiveId(group: string): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY_PREFIX + group);
  } catch {
    return null;
  }
}

function persistActiveId(group: string, id: string): void {
  try {
    localStorage.setItem(ACTIVE_KEY_PREFIX + group, id);
  } catch {
    /* ignore */
  }
}

function resolveActiveByGroup(conversations: Conversation[]): Record<string, string> {
  const active: Record<string, string> = {};
  for (const c of conversations) {
    if (active[c.group]) continue;
    const stored = readActiveId(c.group);
    const valid = stored && conversations.some((x) => x.group === c.group && x.id === stored);
    active[c.group] = valid ? stored! : conversations.find((x) => x.group === c.group)!.id;
  }
  return active;
}

async function loadFromVfs(): Promise<void> {
  let conversations: Conversation[] = [];
  try {
    await fsClient.mkdir(CHATS_DIR).catch(() => {});
    const entries = await fsClient.list(CHATS_DIR);
    const files = entries.filter((e) => e.type === "file" && e.name.endsWith(".json"));
    const loaded: (Conversation | null)[] = await Promise.all(
      files.map(async (e): Promise<Conversation | null> => {
        const id = e.name.replace(/\.json$/, "");
        const file = await readConversationFile(id);
        if (!file) return null;
        return { id: file.id, title: file.title, createdAt: file.createdAt, group: file.group, agentId: file.agentId };
      }),
    );
    conversations = loaded.filter((c): c is Conversation => c !== null);
    conversations.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    conversations = [];
  }

  // The Assistant always has at least one thread (preserves prior behavior).
  if (!conversations.some((c) => c.group === DEFAULT_GROUP)) {
    const seed = freshConversation(DEFAULT_GROUP);
    conversations = [seed, ...conversations];
    try {
      await writeConversationFile({ ...seed, messages: [] });
    } catch {
      /* show the seed anyway; save retries on next mutation */
    }
  }

  const activeByGroup = resolveActiveByGroup(conversations);
  for (const [group, id] of Object.entries(activeByGroup)) persistActiveId(group, id);
  state = { conversations, activeByGroup, loaded: true };
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

export async function newConversation(group: string = DEFAULT_GROUP, agentId?: string): Promise<string> {
  await ensureLoading();
  const conv = freshConversation(group, agentId);
  const current = state ?? { conversations: [], activeByGroup: {}, loaded: true };
  persistActiveId(group, conv.id);
  setState({
    conversations: [conv, ...current.conversations],
    activeByGroup: { ...current.activeByGroup, [group]: conv.id },
    loaded: true,
  });
  try {
    await writeConversationFile({ ...conv, messages: [] });
  } catch (err) {
    console.error("Failed to persist new conversation", err);
  }
  return conv.id;
}

/** Reassign a conversation to a different agent (personality). Updates the
 *  in-memory state immediately so the UI re-renders, then persists the change to
 *  the conversation's file (preserving its message history). */
export async function setConversationAgent(id: string, agentId: string): Promise<void> {
  await ensureLoading();
  const current = state ?? get();
  const conv = current.conversations.find((c) => c.id === id);
  if (!conv || conv.agentId === agentId) return;
  const next = { ...conv, agentId };
  setState({
    ...current,
    conversations: current.conversations.map((c) => (c.id === id ? next : c)),
  });
  try {
    const file = (await readConversationFile(id)) ?? { ...next, messages: [] };
    await writeConversationFile({ ...file, agentId });
  } catch (err) {
    console.error("Failed to persist conversation agent change", err);
  }
}

// id is globally unique; the group is inferred from the conversation.
export function selectConversation(id: string): void {
  const current = get();
  const conv = current.conversations.find((c) => c.id === id);
  if (!conv || current.activeByGroup[conv.group] === id) return;
  persistActiveId(conv.group, id);
  setState({ ...current, activeByGroup: { ...current.activeByGroup, [conv.group]: id } });
}

export async function deleteConversation(id: string): Promise<void> {
  await ensureLoading();
  const current = state ?? get();
  const target = current.conversations.find((c) => c.id === id);
  const group = target?.group ?? DEFAULT_GROUP;
  let conversations = current.conversations.filter((c) => c.id !== id);
  const activeByGroup = { ...current.activeByGroup };

  // The Assistant group always keeps at least one thread.
  if (group === DEFAULT_GROUP && !conversations.some((c) => c.group === DEFAULT_GROUP)) {
    const seed = freshConversation(DEFAULT_GROUP);
    conversations = [seed, ...conversations];
    activeByGroup[DEFAULT_GROUP] = seed.id;
    persistActiveId(DEFAULT_GROUP, seed.id);
    try {
      await writeConversationFile({ ...seed, messages: [] });
    } catch (err) {
      console.error("Failed to seed replacement conversation", err);
    }
  } else if (activeByGroup[group] === id) {
    const next = conversations.find((c) => c.group === group);
    if (next) {
      activeByGroup[group] = next.id;
      persistActiveId(group, next.id);
    } else {
      delete activeByGroup[group];
    }
  }

  setState({ conversations, activeByGroup, loaded: true });
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
  const file: ConversationFile = {
    id,
    title: meta?.title ?? existing?.title ?? "Conversation",
    createdAt: existing?.createdAt ?? meta?.createdAt ?? Date.now(),
    group: meta?.group ?? existing?.group ?? DEFAULT_GROUP,
    agentId: meta?.agentId ?? existing?.agentId,
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
    const cur = state?.conversations.find((c) => c.id === id);
    if (!cur || cur.title !== DEFAULT_TITLE) return;
    await renameConversation(id, title);
  } catch {
    /* title generation is best-effort */
  } finally {
    titleGenInFlight.delete(id);
  }
}

function useStoreState(): State {
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

/** Conversations for a group (default "assistant") + that group's active id. */
export function useConversations(group: string = DEFAULT_GROUP): {
  conversations: Conversation[];
  activeId: string;
  loaded: boolean;
} {
  const s = useStoreState();
  return {
    conversations: s.conversations.filter((c) => c.group === group),
    activeId: s.activeByGroup[group] ?? "",
    loaded: s.loaded,
  };
}

/** All conversations across groups (for a grouped/nested view) + each group's active id. */
export function useAllConversations(): {
  conversations: Conversation[];
  activeByGroup: Record<string, string>;
  loaded: boolean;
} {
  const s = useStoreState();
  return { conversations: s.conversations, activeByGroup: s.activeByGroup, loaded: s.loaded };
}

export function useActiveConversationId(group: string = DEFAULT_GROUP): string {
  return useConversations(group).activeId;
}

/** Active conversation object for a group (the Conversation, not just its id).
 *  Returns null while loading or if the group has no conversations. */
export function useActiveConversation(group: string = DEFAULT_GROUP): Conversation | null {
  const s = useStoreState();
  const id = s.activeByGroup[group];
  if (!id) return null;
  return s.conversations.find((c) => c.id === id) ?? null;
}
