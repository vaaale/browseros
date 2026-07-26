import "server-only";
import { randomBytes } from "crypto";
import { getSecretsStore } from "../secrets/store";
import type { PendingOAuthFlow } from "../types";

// Persistent store of pending PKCE flows keyed by opaque `state` token.
//
// These flows used to live in a process-local Map, but that loses every
// in-flight flow whenever the process restarts between `start` (build auth
// URL) and `callback` (token exchange). In the Bastion → Supervisor → Preview
// Container topology the preview container that served `start` can be rebuilt
// or restarted while the user is on the provider's consent screen; when the
// provider then redirects back to `callback` the Map is empty and the token
// exchange fails ("OAuth state expired or unknown").
//
// We therefore persist pending flows through the SecretsStore — the same
// file-backed, encrypted, atomically-written store that already holds the
// OAuth client credentials and survives restarts. Keeping the PKCE verifier
// encrypted at rest matches how tokens/credentials are stored. Each flow is a
// separate key `oauth_pending:<state>`. Entries expire after 10 minutes; stale
// entries are pruned lazily on read/write.

const TTL_MS = 10 * 60 * 1000;

// SecretsStore integrationId namespace for pending flows. Must not contain ":"
// (see SecretsStore.makeKey). The `state` token is base64url (no ":"), so it is
// a safe key suffix.
const PENDING_NS = "oauth_pending";

async function prune(now: number): Promise<void> {
  const store = getSecretsStore();
  const states = await store.listKeys(PENDING_NS);
  await Promise.all(
    states.map(async (state) => {
      const flow = await store.get<PendingOAuthFlow>(PENDING_NS, state);
      if (!flow || now - flow.createdAt > TTL_MS) {
        await store.delete(PENDING_NS, state);
      }
    }),
  );
}

export async function putPending(input: {
  integrationId: string;
  verifier: string;
  scopes: string[];
  remoteName?: string;
  publicOrigin?: string;
}): Promise<string> {
  const now = Date.now();
  await prune(now);
  const state = randomBytes(24).toString("base64url");
  const flow: PendingOAuthFlow = {
    integrationId: input.integrationId,
    verifier: input.verifier,
    scopes: input.scopes,
    createdAt: now,
    remoteName: input.remoteName,
    publicOrigin: input.publicOrigin,
  };
  await getSecretsStore().set(PENDING_NS, state, flow);
  return state;
}

export async function takePending(state: string): Promise<PendingOAuthFlow | null> {
  const now = Date.now();
  const store = getSecretsStore();
  const flow = await store.get<PendingOAuthFlow>(PENDING_NS, state);
  // Consume the flow (single use) and prune any other stale entries.
  if (flow) await store.delete(PENDING_NS, state);
  await prune(now);
  if (!flow) return null;
  if (now - flow.createdAt > TTL_MS) return null;
  return flow;
}
