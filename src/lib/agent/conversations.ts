"use client";

import { useSyncExternalStore } from "react";
import { fsClient } from "@/lib/os-client";
import { sanitizeLoadedMessages, normalizeMessages, isStaleSnapshot } from "@/lib/agent/conversations-sanitize";
import { DEFAULT_AGENT_ID } from "@/lib/agent/agent-ids";
import { enqueuePerKey } from "@/lib/agent/write-queue";

/**
 * Conversations live as one JSON file per chat under the user's VFS at
 * /Documents/Chats/<id>.json. Each file holds metadata AND message history.
 *
 * Conversations are keyed by agentId: each agent has its own conversation list
 * and its own active-conversation pointer (tracked in localStorage). This
 * replaces the old `group` partition field — agentId is now the sole organising
 * key, so embedded surfaces (Build Studio, etc.) use whichever agent they are
 * configured to use and share that agent's conversation history.
 */

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  agentId: string;
  activeFeatureBranch?: string;
}

interface State {
  conversations: Conversation[];
  activeByAgent: Record<string, string>;
  loaded: boolean;
}

export const CHATS_DIR = "/Documents/Chats";
const ACTIVE_KEY_PREFIX = "bos.activeConversation.";
const DEFAULT_TITLE = "New conversation";
const SERVER_SNAPSHOT: State = { conversations: [], activeByAgent: {}, loaded: false };

const titleGenInFlight = new Set<string>();

function newId(): string {
  return "c-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function normalizeAgentId(agentId?: string): string | undefined {
  if (typeof agentId !== "string") return undefined;
  const trimmed = agentId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function freshConversation(agentId: string): Conversation {
  const id = newId();
  return { id, title: DEFAULT_TITLE, createdAt: Date.now(), agentId };
}

function chatPath(id: string): string {
  return `${CHATS_DIR}/${id}.json`;
}

interface ConversationFile {
  id: string;
  title: string;
  createdAt: number;
  agentId?: string;
  group?: string; // legacy field — read for migration, never written
  activeFeatureBranch?: string;
  messages: unknown[];
}

async function readConversationFile(id: string): Promise<ConversationFile | null> {
  try {
    const content = await fsClient.read(chatPath(id));
    const parsed = JSON.parse(content) as ConversationFile;
    if (!parsed || typeof parsed !== "object") return null;
    // Migration: old files stored a `group` field instead of (or in addition to)
    // agentId. If agentId is missing, derive it from group: a non-default group
    // (e.g. "build-studio") maps 1-to-1 to an agent id of the same name. The
    // legacy default group ("assistant") maps to DEFAULT_AGENT_ID.
    const rawAgentId = typeof parsed.agentId === "string" && parsed.agentId ? parsed.agentId : undefined;
    const rawGroup = typeof parsed.group === "string" && parsed.group ? parsed.group : undefined;
    const agentId = normalizeAgentId(rawAgentId)
      ?? (rawGroup && rawGroup !== "assistant" ? rawGroup : undefined)
      ?? DEFAULT_AGENT_ID;
    return {
      id: parsed.id ?? id,
      title: typeof parsed.title === "string" ? parsed.title : "Conversation",
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
      agentId,
      activeFeatureBranch: typeof parsed.activeFeatureBranch === "string" && parsed.activeFeatureBranch ? parsed.activeFeatureBranch : undefined,
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
    };
  } catch {
    return null;
  }
}

// Raw write — call only from inside an enqueuePerKey(<conversation id>) task.
// Every read-modify-write of a conversation file must be a queued critical
// section so concurrent writers (debounced saves, RUN_ERROR flush, rename/
// agent/branch changes, a second mounted surface) cannot interleave. The
// server side is crash-safe already (writeFileAtomic: temp + fsync + rename).
async function writeConversationFile(file: ConversationFile): Promise<void> {
  await fsClient.write(chatPath(file.id), JSON.stringify(file, null, 2));
}

let state: State | null = null;
let loadPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function readActiveId(agentId: string): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY_PREFIX + agentId);
  } catch {
    return null;
  }
}

function persistActiveId(agentId: string, id: string): void {
  try {
    localStorage.setItem(ACTIVE_KEY_PREFIX + agentId, id);
  } catch {
    /* ignore */
  }
}

function resolveActiveByAgent(conversations: Conversation[]): Record<string, string> {
  const active: Record<string, string> = {};
  for (const c of conversations) {
    if (active[c.agentId]) continue;
    const stored = readActiveId(c.agentId);
    const valid = stored && conversations.some((x) => x.agentId === c.agentId && x.id === stored);
    active[c.agentId] = valid ? stored! : conversations.find((x) => x.agentId === c.agentId)!.id;
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
        return { id: file.id, title: file.title, createdAt: file.createdAt, agentId: file.agentId!, activeFeatureBranch: file.activeFeatureBranch };
      }),
    );
    conversations = loaded.filter((c): c is Conversation => c !== null);
    conversations.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    conversations = [];
  }

  // The default agent always has at least one conversation.
  if (!conversations.some((c) => c.agentId === DEFAULT_AGENT_ID)) {
    const seed = freshConversation(DEFAULT_AGENT_ID);
    conversations = [seed, ...conversations];
    try {
      await enqueuePerKey(seed.id, () => writeConversationFile({ ...seed, messages: [] }));
    } catch {
      /* show the seed anyway; save retries on next mutation */
    }
  }

  const activeByAgent = resolveActiveByAgent(conversations);
  for (const [agentId, id] of Object.entries(activeByAgent)) persistActiveId(agentId, id);
  state = { conversations, activeByAgent, loaded: true };
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

export async function newConversation(agentId: string = DEFAULT_AGENT_ID): Promise<string> {
  await ensureLoading();
  const conv = freshConversation(agentId);
  const current = state ?? { conversations: [], activeByAgent: {}, loaded: true };
  persistActiveId(agentId, conv.id);
  setState({
    conversations: [conv, ...current.conversations],
    activeByAgent: { ...current.activeByAgent, [agentId]: conv.id },
    loaded: true,
  });
  try {
    await enqueuePerKey(conv.id, async () => {
      const file: ConversationFile = {
        id: conv.id,
        title: conv.title,
        createdAt: conv.createdAt,
        agentId: conv.agentId,
        messages: [],
      };
      if (conv.activeFeatureBranch) file.activeFeatureBranch = conv.activeFeatureBranch;
      await writeConversationFile(file);
    });
  } catch (err) {
    console.error("Failed to persist new conversation", err);
  }
  return conv.id;
}

/** Set which feature branch this conversation's developer harness work targets.
 *  The empty string clears the selection. */
export async function setConversationActiveFeatureBranch(id: string, branch: string): Promise<void> {
  await ensureLoading();
  const normalized = branch.trim();
  const activeFeatureBranch = normalized.length > 0 ? normalized : undefined;
  const current = state ?? get();
  const conv = current.conversations.find((c) => c.id === id);
  if (!conv || conv.activeFeatureBranch === activeFeatureBranch) return;
  const next = activeFeatureBranch
    ? { ...conv, activeFeatureBranch }
    : (() => {
        const rest = { ...conv };
        delete rest.activeFeatureBranch;
        return rest;
      })();
  setState({
    ...current,
    conversations: current.conversations.map((c) => (c.id === id ? next : c)),
  });
  try {
    await enqueuePerKey(id, async () => {
      const file = (await readConversationFile(id)) ?? { ...next, messages: [] };
      if (activeFeatureBranch) {
        await writeConversationFile({ ...file, activeFeatureBranch });
      } else {
        const rest = { ...file };
        delete rest.activeFeatureBranch;
        await writeConversationFile(rest);
      }
    });
  } catch (err) {
    console.error("Failed to persist active feature branch change", err);
  }
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
    await enqueuePerKey(id, async () => {
      const file = (await readConversationFile(id)) ?? { ...next, messages: [] };
      await writeConversationFile({ ...file, agentId });
    });
  } catch (err) {
    console.error("Failed to persist conversation agent change", err);
  }
}

// id is globally unique; the agentId is inferred from the conversation.
export function selectConversation(id: string): void {
  const current = get();
  const conv = current.conversations.find((c) => c.id === id);
  if (!conv || current.activeByAgent[conv.agentId] === id) return;
  persistActiveId(conv.agentId, id);
  setState({ ...current, activeByAgent: { ...current.activeByAgent, [conv.agentId]: id } });
}

export async function deleteConversation(id: string): Promise<void> {
  await ensureLoading();
  const current = state ?? get();
  const target = current.conversations.find((c) => c.id === id);
  const agentId = target?.agentId ?? DEFAULT_AGENT_ID;
  let conversations = current.conversations.filter((c) => c.id !== id);
  const activeByAgent = { ...current.activeByAgent };

  // The default agent always keeps at least one thread.
  if (agentId === DEFAULT_AGENT_ID && !conversations.some((c) => c.agentId === DEFAULT_AGENT_ID)) {
    const seed = freshConversation(DEFAULT_AGENT_ID);
    conversations = [seed, ...conversations];
    activeByAgent[DEFAULT_AGENT_ID] = seed.id;
    persistActiveId(DEFAULT_AGENT_ID, seed.id);
    try {
      await enqueuePerKey(seed.id, () => writeConversationFile({ ...seed, messages: [] }));
    } catch (err) {
      console.error("Failed to seed replacement conversation", err);
    }
  } else if (activeByAgent[agentId] === id) {
    const next = conversations.find((c) => c.agentId === agentId);
    if (next) {
      activeByAgent[agentId] = next.id;
      persistActiveId(agentId, next.id);
    } else {
      delete activeByAgent[agentId];
    }
  }

  setState({ conversations, activeByAgent, loaded: true });
  try {
    // Queued so a pending debounced save for this conversation settles first
    // instead of racing the removal.
    await enqueuePerKey(id, () => fsClient.remove(chatPath(id)));
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
    await enqueuePerKey(id, async () => {
      const file = (await readConversationFile(id)) ?? { ...next, messages: [] };
      await writeConversationFile({ ...file, title });
    });
  } catch (err) {
    console.error("Failed to rename conversation file", err);
  }
}

/** Load the persisted messages for a conversation, sanitized so reopening it can
 *  never resume an in-flight turn (no uncommanded agent run) WITHOUT discarding
 *  history — an interrupted tail is closed with a settled note, not deleted. */
export async function loadConversationMessages(id: string): Promise<unknown[]> {
  const file = await readConversationFile(id);
  return sanitizeLoadedMessages(file?.messages ?? []);
}

/** Persist the messages of a conversation, preserving its metadata. The whole
 *  read-modify-write runs as a queued critical section per conversation, and
 *  stale snapshots (an older debounced save arriving after a newer write) are
 *  skipped so they can never clobber fresher history. */
export async function saveConversationMessages(id: string, messages: unknown[]): Promise<void> {
  await enqueuePerKey(id, async () => {
    const meta = state?.conversations.find((c) => c.id === id);
    const existing = await readConversationFile(id);
    if (messages.length === 0 && existing && existing.messages.length > 0) return;
    if (existing && isStaleSnapshot(messages, existing.messages)) {
      console.warn(`[BOS] skipped stale conversation write (${messages.length} < ${existing.messages.length} messages)`, id);
      return;
    }
    const file: ConversationFile = {
      id,
      title: meta?.title ?? existing?.title ?? "Conversation",
      createdAt: existing?.createdAt ?? meta?.createdAt ?? Date.now(),
      agentId: meta?.agentId ?? existing?.agentId ?? DEFAULT_AGENT_ID,
      activeFeatureBranch: meta?.activeFeatureBranch ?? existing?.activeFeatureBranch,
      messages: normalizeMessages(messages),
    };
    await writeConversationFile(file);
  });
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

function firstAssistantText(messages: unknown[]): string | null {
  for (const m of messages) {
    const x = readMessage(m);
    if (x?.role !== "assistant") continue;
    if (typeof x.content === "string" && x.content.trim().length > 0) return x.content;
  }
  return null;
}

async function maybeGenerateTitleInBackground(id: string, messages: unknown[]): Promise<void> {
  if (titleGenInFlight.has(id)) return;
  const meta = state?.conversations.find((c) => c.id === id);
  if (!meta || meta.title !== DEFAULT_TITLE) return;
  const userText = firstUserText(messages);
  const assistantText = firstAssistantText(messages);
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

/** Conversations for an agent + that agent's active conversation id. */
export function useConversations(agentId: string = DEFAULT_AGENT_ID): {
  conversations: Conversation[];
  activeId: string;
  loaded: boolean;
} {
  const s = useStoreState();
  return {
    conversations: s.conversations.filter((c) => c.agentId === agentId),
    activeId: s.activeByAgent[agentId] ?? "",
    loaded: s.loaded,
  };
}

/** All conversations across agents + each agent's active id. */
export function useAllConversations(): {
  conversations: Conversation[];
  activeByAgent: Record<string, string>;
  loaded: boolean;
} {
  const s = useStoreState();
  return { conversations: s.conversations, activeByAgent: s.activeByAgent, loaded: s.loaded };
}

export function useActiveConversationId(agentId: string = DEFAULT_AGENT_ID): string {
  return useConversations(agentId).activeId;
}

/** Active conversation object for an agent.
 *  Returns null while loading or if the agent has no conversations. */
export function useActiveConversation(agentId: string = DEFAULT_AGENT_ID): Conversation | null {
  const s = useStoreState();
  const id = s.activeByAgent[agentId];
  if (!id) return null;
  return s.conversations.find((c) => c.id === id) ?? null;
}
