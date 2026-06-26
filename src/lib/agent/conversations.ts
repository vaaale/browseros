"use client";

import { useSyncExternalStore } from "react";

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
}

interface State {
  conversations: Conversation[];
  activeId: string;
}

const KEY = "bos.conversations";
const ACTIVE_KEY = "bos.activeConversation";
const SERVER_SNAPSHOT: State = { conversations: [{ id: "default", title: "Conversation", createdAt: 0 }], activeId: "default" };

function newId(): string {
  return "c-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function freshConversation(): Conversation {
  return { id: newId(), title: "New conversation", createdAt: Date.now() };
}

let state: State | null = null;
const listeners = new Set<() => void>();

function load(): State {
  try {
    const conversations = JSON.parse(localStorage.getItem(KEY) || "[]") as Conversation[];
    if (conversations.length === 0) return { conversations: [freshConversation()], activeId: "" } as State;
    const activeId = localStorage.getItem(ACTIVE_KEY) || conversations[0].id;
    return { conversations, activeId: conversations.some((c) => c.id === activeId) ? activeId : conversations[0].id };
  } catch {
    const c = freshConversation();
    return { conversations: [c], activeId: c.id };
  }
}

function get(): State {
  if (!state) {
    state = typeof localStorage === "undefined" ? SERVER_SNAPSHOT : load();
    if (!state.activeId && state.conversations[0]) state = { ...state, activeId: state.conversations[0].id };
  }
  return state;
}

function set(next: State): void {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next.conversations));
    localStorage.setItem(ACTIVE_KEY, next.activeId);
  } catch {
    /* ignore */
  }
  for (const l of listeners) l();
}

export function newConversation(): void {
  const c = freshConversation();
  const s = get();
  set({ conversations: [c, ...s.conversations], activeId: c.id });
}

export function selectConversation(id: string): void {
  set({ ...get(), activeId: id });
}

export function deleteConversation(id: string): void {
  const s = get();
  let conversations = s.conversations.filter((c) => c.id !== id);
  if (conversations.length === 0) conversations = [freshConversation()];
  const activeId = s.activeId === id ? conversations[0].id : s.activeId;
  set({ conversations, activeId });
}

export function renameConversation(id: string, title: string): void {
  const s = get();
  set({ ...s, conversations: s.conversations.map((c) => (c.id === id ? { ...c, title } : c)) });
}

export function useConversations(): State {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => get(),
    () => SERVER_SNAPSHOT,
  );
}

export function useActiveConversationId(): string {
  return useConversations().activeId;
}
