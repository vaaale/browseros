"use client";

import { useSyncExternalStore } from "react";

// Module-level collapse state + timers for event cards. Lives outside React so
// the auto-collapse timer survives the frequent remounts that happen while the
// assistant turn is still streaming (a per-component setTimeout would be
// cleared on unmount before it fires).
const COLLAPSE_MS = 4000;

const collapsed = new Map<string, boolean>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/** Schedule auto-collapse once a card's event completes (idempotent). */
export function markComplete(id: string): void {
  if (collapsed.has(id) || timers.has(id)) return;
  const t = setTimeout(() => {
    timers.delete(id);
    collapsed.set(id, true);
    emit();
  }, COLLAPSE_MS);
  timers.set(id, t);
}

/** Manual toggle: cancels any pending auto-collapse and pins the state. */
export function setCollapsed(id: string, value: boolean): void {
  const t = timers.get(id);
  if (t) {
    clearTimeout(t);
    timers.delete(id);
  }
  collapsed.set(id, value);
  emit();
}

export function useCollapsed(id: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => collapsed.get(id) ?? false,
    () => false,
  );
}
