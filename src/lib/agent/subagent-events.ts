"use client";

import { useSyncExternalStore } from "react";

export interface SAEvent {
  tool: string;
  input?: unknown;
}

export interface DelegationState {
  events: SAEvent[];
  done: boolean;
  output?: string;
}

// Live store of in-flight delegations, keyed by task text, so the chat can show
// a sub-agent's tool events as they stream in (not just when it finishes).
// Entries are only needed while streaming: on completion the tool result carries
// the same events/output (encodeNested), which the tool-call card falls back to —
// so finished entries are evicted after a grace period to keep the store bounded
// for the life of the tab.
const EVICT_AFTER_MS = 60_000;

const store = new Map<string, DelegationState>();
const listeners = new Set<() => void>();
const evictTimers = new Map<string, ReturnType<typeof setTimeout>>();

function emit() {
  for (const l of listeners) l();
}

export function startDelegation(key: string): void {
  const pending = evictTimers.get(key);
  if (pending) {
    clearTimeout(pending);
    evictTimers.delete(key);
  }
  store.set(key, { events: [], done: false });
  emit();
}

export function pushDelegationEvent(key: string, e: SAEvent): void {
  const d = store.get(key);
  if (!d) return;
  // Replace the object so useSyncExternalStore detects the change.
  store.set(key, { ...d, events: [...d.events, e] });
  emit();
}

export function finishDelegation(key: string, output: string): void {
  const d = store.get(key) ?? { events: [], done: false };
  store.set(key, { ...d, done: true, output });
  emit();
  const timer = setTimeout(() => {
    evictTimers.delete(key);
    store.delete(key);
    emit();
  }, EVICT_AFTER_MS);
  evictTimers.set(key, timer);
}

export function useDelegation(key: string): DelegationState | undefined {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => (key ? store.get(key) : undefined),
    () => undefined,
  );
}
