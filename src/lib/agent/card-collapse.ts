"use client";

import { useSyncExternalStore } from "react";

// Shared collapse state for Assistant cards (tool-call cards + reasoning cards).
//
// The cards form an ordered accordion: the most recently inserted card is the
// only one expanded, so inserting any new card — or the agent's answer — collapses
// the previously-open card. Clicking a card header toggles just that card (and,
// being an accordion, opening one collapses the rest).
//
// State lives module-side rather than in React because the card components are
// remounted frequently while a turn is still streaming; a per-component state
// would be reset on every remount, losing the open/closed selection.

// Every card id ever registered — used to make registration idempotent so the
// "newest opens" rule only fires the first time a card appears.
const seen = new Set<string>();
// The single currently-expanded card, or null when everything is collapsed.
let openId: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

// Register a card by stable id. The first time a given id is seen it becomes the
// open card (collapsing whatever was open) — this is the "a new card collapses
// the previous one" rule. Idempotent: re-registering a known id is a no-op, so
// the frequent re-renders/remounts during streaming don't reshuffle the view.
export function registerCard(id: string): void {
  if (seen.has(id)) return;
  seen.add(id);
  openId = id;
  emit();
}

// Manual toggle from a card header: open it (collapsing the others) if it isn't
// open, otherwise collapse it so nothing is expanded.
export function toggleCard(id: string): void {
  openId = openId === id ? null : id;
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// True when this card is the expanded one. Safe under SSR (collapsed by default).
export function useCardOpen(id: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => openId === id,
    () => false,
  );
}
