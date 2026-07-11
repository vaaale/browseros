"use client";

// Elicitation store — v2's replacement for CopilotKit's renderAndWaitForResponse.
// An elicitation TOOL's handler pushes a pending entry here and awaits; the
// message list renders a blocking card for it; the user's choice resolves the
// handler, whose return string goes back to the server loop as the tool result.
// If the run is stopped (kernel aborts the handler), the entry is withdrawn.

import { useSyncExternalStore } from "react";

export interface PendingElicitation {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  conversationId: string;
  resolve: (result: string) => void;
}

let pending: PendingElicitation[] = [];
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

export function useElicitations(conversationId: string): PendingElicitation[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => pending,
    () => pending,
  ).filter((p) => p.conversationId === conversationId);
}

/** Push an elicitation and await the user's choice. Settles when the card
 *  resolves it OR the handler's signal aborts (run stopped) — never hangs. */
export function elicit(
  tool: string,
  input: Record<string, unknown>,
  conversationId: string,
  signal: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolvePromise) => {
    const id = `${tool}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let done = false;
    const settle = (result: string) => {
      if (done) return;
      done = true;
      pending = pending.filter((p) => p.id !== id);
      signal.removeEventListener("abort", onAbort);
      notify();
      resolvePromise(result);
    };
    const onAbort = () => settle("Cancelled by user.");
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) return onAbort();
    pending = [...pending, { id, tool, input, conversationId, resolve: settle }];
    notify();
  });
}
