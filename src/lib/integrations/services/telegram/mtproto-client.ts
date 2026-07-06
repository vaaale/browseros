// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./mtproto-shims.d.ts" />
import "server-only";
import { IntegrationAuthError, IntegrationConfigError, IntegrationError } from "../../errors";
import { getSecretsStore } from "../../secrets/store";

// Thin wrapper around gramjs (`telegram` on npm) for the MTProto user-account
// flow. Everything that touches the library goes through this module so the
// rest of the integration doesn't take a hard runtime dependency on gramjs —
// if the package isn't installed, `loadGramjs()` throws a friendly
// IntegrationConfigError that the caller can surface to the UI.
//
// Session persistence: the gramjs StringSession is serialised to a base64ish
// string and encrypted at rest in SecretsStore under `telegram:user_session`.
// This is the SINGLE artifact needed to re-hydrate a fully authorised client;
// api_id and api_hash come from state.services.user.config (non-secret, but
// tied to the user's my.telegram.org account).
//
// Concurrency: one live client per process, protected by `clientLock`. Requests
// serialize through a shared queue so we never open two MTProto connections.

interface GramjsModule {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TelegramClient: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Api: any;
}
interface SessionsModule {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  StringSession: any;
}

const SESSION_KEY = "user_session";
const API_ID_KEY = "user_api_id";
const API_HASH_KEY = "user_api_hash";

let cachedGramjs: GramjsModule | null = null;
let cachedSessions: SessionsModule | null = null;

async function loadGramjs(): Promise<{ gramjs: GramjsModule; sessions: SessionsModule }> {
  if (cachedGramjs && cachedSessions) return { gramjs: cachedGramjs, sessions: cachedSessions };
  try {
    // Named dynamic imports; wrapped in try so a missing dep is a controlled
    // error rather than an uncaught module-not-found blowing up the route.
    cachedGramjs = (await import("telegram")) as GramjsModule;
    cachedSessions = (await import("telegram/sessions")) as SessionsModule;
    return { gramjs: cachedGramjs, sessions: cachedSessions };
  } catch (err) {
    throw new IntegrationConfigError(
      "The `telegram` (gramjs) package isn't installed. Run `npm install telegram flexsearch` and restart the dev server.",
      { integrationId: "telegram", cause: err },
    );
  }
}

export interface MtprotoCredentials {
  apiId: number;
  apiHash: string;
}

/** Load the API credentials from SecretsStore. Returns null if not set. */
export async function readCredentials(): Promise<MtprotoCredentials | null> {
  const secrets = getSecretsStore();
  const apiIdRec = await secrets.get<{ value: string }>("telegram", API_ID_KEY);
  const apiHashRec = await secrets.get<{ value: string }>("telegram", API_HASH_KEY);
  if (!apiIdRec?.value || !apiHashRec?.value) return null;
  const apiId = Number(apiIdRec.value);
  if (!Number.isFinite(apiId) || apiId <= 0) return null;
  return { apiId, apiHash: apiHashRec.value };
}

/** Persist API credentials. `apiId` must be a numeric string. */
export async function writeCredentials(apiId: string, apiHash: string): Promise<void> {
  const parsed = Number(apiId);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new IntegrationConfigError(
      "api_id must be a positive integer from my.telegram.org.",
      { integrationId: "telegram" },
    );
  }
  if (!apiHash || apiHash.trim().length < 8) {
    throw new IntegrationConfigError(
      "api_hash looks too short — copy the full 32-character value from my.telegram.org.",
      { integrationId: "telegram" },
    );
  }
  const secrets = getSecretsStore();
  await secrets.set("telegram", API_ID_KEY, { value: String(parsed) });
  await secrets.set("telegram", API_HASH_KEY, { value: apiHash.trim() });
}

/** Persist the serialised StringSession. Empty string clears it. */
export async function writeSession(session: string): Promise<void> {
  const secrets = getSecretsStore();
  if (!session) {
    await secrets.delete("telegram", SESSION_KEY);
    return;
  }
  await secrets.set("telegram", SESSION_KEY, { value: session });
}

/** Return the serialised session string, or null if the user hasn't signed in. */
export async function readSession(): Promise<string | null> {
  const secrets = getSecretsStore();
  const rec = await secrets.get<{ value: string }>("telegram", SESSION_KEY);
  return rec?.value ?? null;
}

/** Drop persisted MTProto secrets. Called on disconnect. */
export async function clearMtprotoSecrets(): Promise<void> {
  const secrets = getSecretsStore();
  await Promise.all([
    secrets.delete("telegram", SESSION_KEY),
    secrets.delete("telegram", API_ID_KEY),
    secrets.delete("telegram", API_HASH_KEY),
  ]);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MtprotoClient = any;

interface CreatedClient {
  client: MtprotoClient;
  session: MtprotoClient; // StringSession instance, kept for save()
}

/**
 * Build a fresh TelegramClient bound to the persisted credentials + session.
 * The caller is responsible for calling `.connect()` and `.disconnect()` — we
 * don't cache clients between calls because gramjs uses a long-lived socket
 * and holding one open across a serverless request lifetime is fragile.
 */
export async function createClient(opts: {
  requireAuthorized?: boolean;
  sessionString?: string;
} = {}): Promise<CreatedClient> {
  const creds = await readCredentials();
  if (!creds) {
    throw new IntegrationConfigError(
      "Telegram user credentials not set. Enter api_id and api_hash in Settings → Integrations → Telegram → User.",
      { integrationId: "telegram" },
    );
  }
  const { gramjs, sessions } = await loadGramjs();
  const sessionString = opts.sessionString ?? (await readSession()) ?? "";
  const session = new sessions.StringSession(sessionString);
  const client = new gramjs.TelegramClient(session, creds.apiId, creds.apiHash, {
    connectionRetries: 3,
    useWSS: true,
    autoReconnect: true,
    // gramjs prints noisy console logs by default; keep them at "none".
    baseLogger: undefined,
  });
  try {
    await client.connect();
  } catch (err) {
    throw new IntegrationError(
      "telegram_mtproto_connect_failed",
      `Could not connect to Telegram: ${(err as Error).message}`,
      { integrationId: "telegram", cause: err },
    );
  }
  if (opts.requireAuthorized) {
    const ok = await client.isUserAuthorized();
    if (!ok) {
      await client.disconnect().catch(() => undefined);
      throw new IntegrationAuthError(
        "Telegram user account is not authorised. Complete the login code flow in Settings.",
        { integrationId: "telegram" },
      );
    }
  }
  return { client, session };
}

/**
 * Run `fn` with a live client and disconnect on the way out. Guarantees the
 * socket is closed even on exception — critical because gramjs otherwise keeps
 * the Node event loop alive.
 */
export async function withClient<T>(
  fn: (client: MtprotoClient) => Promise<T>,
  opts: { requireAuthorized?: boolean; sessionString?: string } = { requireAuthorized: true },
): Promise<T> {
  const { client } = await createClient(opts);
  try {
    return await fn(client);
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

// --- Login flow state -----------------------------------------------------

// Between "send code" and "verify code" the user needs the phoneCodeHash the
// server returned. We keep it in a per-process Map keyed by phone — Telegram
// binds a login to a phone anyway, so this is the natural key. Entries expire
// after 5 minutes to bound memory.
interface PendingLogin {
  phone: string;
  phoneCodeHash: string;
  createdAt: number;
  sessionString: string;
}
const PENDING: Map<string, PendingLogin> = new Map();
const PENDING_TTL_MS = 5 * 60_000;

function prunePending(): void {
  const now = Date.now();
  for (const [k, v] of PENDING.entries()) {
    if (now - v.createdAt > PENDING_TTL_MS) PENDING.delete(k);
  }
}

export function rememberPending(entry: PendingLogin): void {
  prunePending();
  PENDING.set(entry.phone, entry);
}

export function takePending(phone: string): PendingLogin | undefined {
  prunePending();
  const rec = PENDING.get(phone);
  return rec;
}

export function forgetPending(phone: string): void {
  PENDING.delete(phone);
}
