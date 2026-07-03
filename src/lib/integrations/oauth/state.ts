import "server-only";
import { randomBytes } from "crypto";
import type { PendingOAuthFlow } from "../types";

// In-memory map of pending PKCE flows keyed by opaque `state` token. Entries
// expire after 10 minutes; a stale entry is pruned lazily on read. Survives
// process life only — a restart mid-flow invalidates every pending flow.

const TTL_MS = 10 * 60 * 1000;

const pending = new Map<string, PendingOAuthFlow>();

function prune(now: number): void {
  for (const [state, flow] of pending) {
    if (now - flow.createdAt > TTL_MS) pending.delete(state);
  }
}

export function putPending(input: {
  integrationId: string;
  verifier: string;
  scopes: string[];
}): string {
  const now = Date.now();
  prune(now);
  const state = randomBytes(24).toString("base64url");
  pending.set(state, {
    integrationId: input.integrationId,
    verifier: input.verifier,
    scopes: input.scopes,
    createdAt: now,
  });
  return state;
}

export function takePending(state: string): PendingOAuthFlow | null {
  const now = Date.now();
  prune(now);
  const flow = pending.get(state);
  if (!flow) return null;
  pending.delete(state);
  if (now - flow.createdAt > TTL_MS) return null;
  return flow;
}
