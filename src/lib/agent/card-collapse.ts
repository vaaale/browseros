"use client";

import { createContext, createElement, useContext, useSyncExternalStore, type ReactNode } from "react";

// Shared collapse state for Assistant cards (tool-call cards + reasoning cards).
//
// The cards form an ordered accordion: the most recently inserted card is the
// only one expanded, so inserting any new card — or the agent's answer — collapses
// the previously-open card. Clicking a card header toggles just that card.
//
// State lives module-side rather than in React because the card components are
// remounted frequently while a turn is still streaming; per-component state would
// reset on every remount, losing the open/closed selection.
//
// The accordion is SCOPED (012-embeddable-assistant): each chat surface (the
// Assistant app, the Build Studio embed) has its own accordion keyed by a scope,
// so multiple open chats don't fight over a single shared open card. Components
// read their scope from CardScopeContext (default "assistant").

const DEFAULT_SCOPE = "assistant";

const CardScopeContext = createContext<string>(DEFAULT_SCOPE);

export function CardScopeProvider({ scope, children }: { scope: string; children: ReactNode }) {
  return createElement(CardScopeContext.Provider, { value: scope }, children);
}

export function useCardScope(): string {
  return useContext(CardScopeContext);
}

// Per-scope: every card id ever registered (idempotent "newest opens"), and the
// single currently-expanded card (or null when all collapsed).
const seenByScope = new Map<string, Set<string>>();
const openByScope = new Map<string, string | null>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function seenFor(scope: string): Set<string> {
  let s = seenByScope.get(scope);
  if (!s) {
    s = new Set();
    seenByScope.set(scope, s);
  }
  return s;
}

// First time a given id is seen in its scope it becomes the open card (collapsing
// whatever was open in that scope). Idempotent: re-registering a known id is a
// no-op, so re-renders/remounts during streaming don't reshuffle the view.
export function registerCard(scope: string, id: string): void {
  const seen = seenFor(scope);
  if (seen.has(id)) return;
  seen.add(id);
  openByScope.set(scope, id);
  emit();
}

// Manual toggle from a card header: open it (collapsing the rest in this scope)
// if it isn't open, otherwise collapse it so nothing is expanded.
export function toggleCard(scope: string, id: string): void {
  openByScope.set(scope, openByScope.get(scope) === id ? null : id);
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// True when this card is the expanded one in its scope. Safe under SSR.
export function useCardOpen(scope: string, id: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => openByScope.get(scope) === id,
    () => false,
  );
}
