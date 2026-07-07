"use client";

import { useSyncExternalStore } from "react";
import { createStore } from "zustand/vanilla";

// Per-conversation "revealed" set: tool ids the user's active agent has already
// discovered via find_tools in this conversation (025-deferred-tool-discovery,
// client-side gating). Deferred tools stay hidden from the model until they are
// revealed, at which point gated-action registers them as `available: true` in
// subsequent renders.
//
// Kept in memory only — resets on page reload, matching the runtime discovery
// contract (a fresh browser session is a fresh loop, so nothing is pre-revealed).
// Stored as arrays (not Sets) so Zustand's structural equality works and React
// selectors don't re-render every tick.
interface RevealedState {
  byConv: Record<string, string[]>;
  add: (conversationId: string, ids: string[]) => void;
  clear: (conversationId: string) => void;
}

const EMPTY: string[] = [];

const revealedStore = createStore<RevealedState>()((set, get) => ({
  byConv: {},
  add: (conversationId, ids) => {
    if (!conversationId || ids.length === 0) return;
    const existing = get().byConv[conversationId] ?? EMPTY;
    const set0 = new Set(existing);
    let changed = false;
    for (const id of ids) {
      if (!set0.has(id)) {
        set0.add(id);
        changed = true;
      }
    }
    if (!changed) return;
    set({ byConv: { ...get().byConv, [conversationId]: Array.from(set0) } });
  },
  clear: (conversationId) => {
    if (!conversationId) return;
    const next = { ...get().byConv };
    delete next[conversationId];
    set({ byConv: next });
  },
}));

/** Reactively read the set of revealed tool ids for a conversation. */
export function useRevealed(conversationId: string): string[] {
  return useSyncExternalStore(
    revealedStore.subscribe,
    () => revealedStore.getState().byConv[conversationId] ?? EMPTY,
    () => EMPTY,
  );
}

/** Add ids to the revealed set for a conversation (idempotent). */
export function addRevealed(conversationId: string, ids: string[]): void {
  revealedStore.getState().add(conversationId, ids);
}

/** Drop all revealed entries for a conversation. */
export function clearRevealed(conversationId: string): void {
  revealedStore.getState().clear(conversationId);
}

/** Non-reactive check (for callbacks / non-render contexts). */
export function hasRevealed(conversationId: string, id: string): boolean {
  const list = revealedStore.getState().byConv[conversationId];
  return !!list && list.includes(id);
}
