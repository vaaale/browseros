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
const store = new Map<string, DelegationState>();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function startDelegation(key: string): void {
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
