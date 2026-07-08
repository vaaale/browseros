import "server-only";
import { IntegrationAuthError, IntegrationConfigError, IntegrationError } from "../../errors";
import { getSecretsStore } from "../../secrets/store";
import { mutateState } from "../../state/store";
import { telegramFetch } from "./client";
import { TELEGRAM_BOT_SCOPES, TELEGRAM_USER_SCOPES } from "./manifest";
import {
  clearMtprotoSecrets,
  createClient,
  forgetPending,
  readCredentials,
  readSession,
  rememberPending,
  takePending,
  writeCredentials,
  writeSession,
} from "./mtproto-client";

// Bot-token auth flow. Called by the Telegram-specific connect/disconnect
// routes (`/api/integrations/telegram/bot/connect|disconnect`) — this module
// stays deliberately outside the shared OAuthManager because Telegram bots
// don't have a 3-legged OAuth flow.
//
// Storage:
//   - Bot token → SecretsStore under `telegram:bot_token` (encrypted at rest).
//   - Bot metadata (username, id) → mirrored into `state.services.bot.config.botInfo`
//     for the UI. Not sensitive.
//   - `state.connected = true` + `state.oauthMeta.granted_scopes = [<bot scopes>]`
//     so the shared framework treats the integration as connected + scoped.

const BOT_TOKEN_KEY = "bot_token";

export interface BotInfo {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
  supports_inline_queries?: boolean;
}

/**
 * Load the persisted bot token. Returns null if the user hasn't connected yet.
 * Adapter methods call this on every request — token stays in SecretsStore
 * (encrypted) and never touches state.json.
 */
export async function readBotToken(): Promise<string | null> {
  const secret = await getSecretsStore().get<{ token: string }>("telegram", BOT_TOKEN_KEY);
  return secret?.token ?? null;
}

/**
 * Return the token or throw a config error the invoke route can surface as a
 * 400 with a helpful message.
 */
export async function requireBotToken(): Promise<string> {
  const token = await readBotToken();
  if (!token) {
    throw new IntegrationConfigError(
      "Telegram bot is not connected. Add a bot token in Settings → Integrations → Telegram.",
      { integrationId: "telegram" },
    );
  }
  return token;
}

// Bot tokens have the shape `<id>:<35-char-secret>` — validate cheaply before
// hitting the network so a paste of "TODO" or an obviously bad value fails
// fast in the UI.
function looksLikeBotToken(token: string): boolean {
  return /^\d+:[A-Za-z0-9_-]{20,}$/.test(token.trim());
}

/**
 * Validate a bot token by calling `getMe`. Returns the bot's public profile
 * on success; throws `IntegrationAuthError` on 401 or `IntegrationConfigError`
 * on a syntactically invalid token.
 */
export async function validateBotToken(token: string): Promise<BotInfo> {
  const trimmed = token.trim();
  if (!looksLikeBotToken(trimmed)) {
    throw new IntegrationConfigError(
      "Bot token doesn't match the expected @BotFather format (`<id>:<secret>`).",
      { integrationId: "telegram" },
    );
  }
  try {
    return await telegramFetch<BotInfo>(trimmed, "getMe");
  } catch (err) {
    if (err instanceof IntegrationAuthError) throw err;
    throw new IntegrationAuthError(
      `Bot token validation failed: ${(err as Error).message}`,
      { integrationId: "telegram", cause: err },
    );
  }
}

/**
 * Full connect flow: validate → persist token → set connected+scopes in state.
 * Called by the connect route.
 */
export async function connectBot(token: string): Promise<BotInfo> {
  const info = await validateBotToken(token);
  await getSecretsStore().set("telegram", BOT_TOKEN_KEY, { token: token.trim() });
  const now = Date.now();
  await mutateState("telegram", (prev) => {
    const services = { ...prev.services };
    const existing = services["bot"] ?? { enabled: true, config: {} };
    services["bot"] = {
      ...existing,
      enabled: true,
      config: {
        ...(existing.config ?? {}),
        botInfo: info,
      },
      lastSync: undefined,
      error: undefined,
    };
    return {
      ...prev,
      connected: true,
      lastConnected: now,
      services,
      oauthMeta: {
        expires_at: 0,
        granted_scopes: Object.values(TELEGRAM_BOT_SCOPES),
      },
      lastError: undefined,
    };
  });
  return info;
}

// --- MTProto user-account flow -------------------------------------------

// The user service authenticates via my.telegram.org's api_id + api_hash and a
// phone-code SMS. The flow is:
//   1. User pastes api_id + api_hash in Settings → we persist them and mark
//      the user service "credentials set".
//   2. User submits their phone number → we call gramjs `sendCode()` which
//      instructs Telegram to SMS/Telegram-app the code. The returned
//      phoneCodeHash is stored in-process (see mtproto-client's PENDING map).
//   3. User submits the code → we call `signInUser()` with { phoneCode,
//      phoneCodeHash }. On success gramjs returns the fully-authorised
//      session; we serialise it via StringSession.save() and encrypt into
//      SecretsStore.
//   4. From now on every user-service adapter call re-hydrates a client from
//      that session string, does its work, and disconnects.
//
// 2FA (password): if the account has a cloud password set, `signInUser` will
// call `onPasswordNeeded`; we throw a distinct error so the UI can prompt.

export interface UserStatus {
  credentialsSet: boolean;
  authorized: boolean;
  phone?: string;
  userId?: number;
  username?: string;
  firstName?: string;
}

/** Snapshot the current MTProto user-account state for the settings UI. */
export async function readUserStatus(): Promise<UserStatus> {
  const creds = await readCredentials();
  if (!creds) return { credentialsSet: false, authorized: false };
  const session = await readSession();
  if (!session) return { credentialsSet: true, authorized: false };
  try {
    const { client } = await createClient({ requireAuthorized: false });
    try {
      const authorized = await client.isUserAuthorized();
      if (!authorized) return { credentialsSet: true, authorized: false };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const me: any = await client.getEntity("me");
      return {
        credentialsSet: true,
        authorized: true,
        userId: typeof me?.id === "object" && typeof me.id.value === "bigint"
          ? Number(me.id.value)
          : typeof me?.id === "number"
            ? me.id
            : undefined,
        username: me?.username ?? undefined,
        firstName: me?.firstName ?? me?.first_name ?? undefined,
        phone: me?.phone ?? undefined,
      };
    } finally {
      await client.disconnect().catch(() => undefined);
    }
  } catch (err) {
    // Auth error / bad session → downgrade to "creds set but not authorised".
    if (err instanceof IntegrationAuthError) {
      return { credentialsSet: true, authorized: false };
    }
    throw err;
  }
}

/** Persist api_id + api_hash. Called from the settings UI. */
export async function setUserCredentials(apiId: string, apiHash: string): Promise<void> {
  await writeCredentials(apiId, apiHash);
  await mutateState("telegram", (prev) => {
    const services = { ...prev.services };
    const existing = services["user"] ?? { enabled: true, config: {} };
    services["user"] = {
      ...existing,
      enabled: true,
      config: { ...(existing.config ?? {}), credentialsSet: true },
      error: undefined,
    };
    return { ...prev, services };
  });
}

/**
 * Start the phone-code login flow. Instructs Telegram to send the auth code
 * (via app if the user has an active session elsewhere, otherwise SMS) and
 * caches the phoneCodeHash keyed by phone.
 */
export async function startUserLogin(phone: string): Promise<{ codeSentTo: "app" | "sms"; phone: string }> {
  const trimmed = phone.trim();
  if (!/^\+?\d[\d\s\-]{6,}$/.test(trimmed)) {
    throw new IntegrationConfigError(
      "Phone number should be in international format (e.g. +14155551234).",
      { integrationId: "telegram" },
    );
  }
  const normalisedPhone = trimmed.startsWith("+") ? trimmed : `+${trimmed}`;
  const creds = await readCredentials();
  if (!creds) {
    throw new IntegrationConfigError(
      "Set api_id and api_hash before requesting a login code.",
      { integrationId: "telegram" },
    );
  }
  const { client, session } = await createClient({
    requireAuthorized: false,
    sessionString: "",
  });
  try {
    const res = await client.sendCode(
      { apiId: creds.apiId, apiHash: creds.apiHash },
      normalisedPhone,
    );
    // Save the pending StringSession so verifyUserCode picks up the same
    // session on the next request — otherwise gramjs can't correlate the
    // code with the started auth flow.
    rememberPending({
      phone: normalisedPhone,
      phoneCodeHash: res?.phoneCodeHash ?? "",
      sessionString: session.save() ?? "",
      createdAt: Date.now(),
    });
    return {
      codeSentTo: res?.isCodeViaApp ? "app" : "sms",
      phone: normalisedPhone,
    };
  } catch (err) {
    throw new IntegrationError(
      "telegram_send_code_failed",
      `Could not request a login code: ${(err as Error).message}`,
      { integrationId: "telegram", cause: err },
    );
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

/**
 * Complete the phone-code login. On success the session is persisted and the
 * user service is marked connected. If the account has a 2FA cloud password
 * this throws `two_factor_required`; caller should show a password prompt and
 * re-invoke with the password field set.
 */
export async function verifyUserCode(input: {
  phone: string;
  code: string;
  password?: string;
}): Promise<{ ok: true; userId?: number; username?: string }> {
  const normalisedPhone = input.phone.startsWith("+") ? input.phone : `+${input.phone}`;
  const pending = takePending(normalisedPhone);
  if (!pending) {
    throw new IntegrationConfigError(
      "No pending login for that phone. Request a fresh code and try again.",
      { integrationId: "telegram" },
    );
  }
  const creds = await readCredentials();
  if (!creds) {
    throw new IntegrationConfigError(
      "Credentials cleared mid-flow. Re-enter api_id and api_hash.",
      { integrationId: "telegram" },
    );
  }
  const { client, session } = await createClient({
    requireAuthorized: false,
    sessionString: pending.sessionString,
  });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const me: any = await client.signInUser(
      { apiId: creds.apiId, apiHash: creds.apiHash },
      {
        phoneNumber: normalisedPhone,
        phoneCode: async () => input.code.trim(),
        password: async () => {
          if (!input.password) {
            throw new IntegrationError(
              "two_factor_required",
              "This account has a cloud password. Provide `password` in the request body.",
              { integrationId: "telegram" },
            );
          }
          return input.password;
        },
        onError: async (err: Error) => {
          // Returning true would let gramjs retry; false surfaces the error.
          throw err;
        },
      },
    );
    // Success — persist the session and mark connected.
    const serialised = session.save();
    if (!serialised) {
      throw new IntegrationError(
        "telegram_session_empty",
        "Login succeeded but no session was returned. Try again.",
        { integrationId: "telegram" },
      );
    }
    await writeSession(serialised);
    await mutateState("telegram", (prev) => {
      const services = { ...prev.services };
      const existing = services["user"] ?? { enabled: true, config: {} };
      services["user"] = {
        ...existing,
        enabled: true,
        config: {
          ...(existing.config ?? {}),
          credentialsSet: true,
          userId: typeof me?.id === "object" && typeof me.id.value === "bigint"
            ? Number(me.id.value)
            : typeof me?.id === "number"
              ? me.id
              : undefined,
          username: me?.username,
        },
        lastSync: Date.now(),
        error: undefined,
      };
      // Grant user scopes so the framework treats it as connected.
      const oauthMeta = prev.oauthMeta ?? { expires_at: 0, granted_scopes: [] };
      const grantedSet = new Set(oauthMeta.granted_scopes);
      for (const s of Object.values(TELEGRAM_USER_SCOPES)) grantedSet.add(s);
      return {
        ...prev,
        connected: true,
        lastConnected: Date.now(),
        services,
        oauthMeta: { ...oauthMeta, granted_scopes: [...grantedSet] },
        lastError: undefined,
      };
    });
    forgetPending(normalisedPhone);
    return {
      ok: true,
      userId: typeof me?.id === "object" && typeof me.id.value === "bigint"
        ? Number(me.id.value)
        : typeof me?.id === "number"
          ? me.id
          : undefined,
      username: me?.username,
    };
  } catch (err) {
    if (err instanceof IntegrationError) throw err;
    const msg = (err as Error).message ?? "sign-in failed";
    if (/password/i.test(msg)) {
      throw new IntegrationError(
        "two_factor_required",
        "Cloud password required. Include `password` in the request body.",
        { integrationId: "telegram" },
      );
    }
    throw new IntegrationAuthError(`Sign-in failed: ${msg}`, {
      integrationId: "telegram",
      cause: err,
    });
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

/** Disconnect the user service. Wipes session + credentials. */
export async function disconnectUser(): Promise<void> {
  await clearMtprotoSecrets();
  await mutateState("telegram", (prev) => {
    const services = { ...prev.services };
    const existing = services["user"];
    if (existing) {
      const nextConfig = { ...(existing.config ?? {}) };
      delete nextConfig.credentialsSet;
      delete nextConfig.userId;
      delete nextConfig.username;
      services["user"] = { ...existing, config: nextConfig };
    }
    // Remove user scopes from granted set. Keep the bot service state.
    const oauthMeta = prev.oauthMeta;
    let nextOauthMeta = oauthMeta;
    if (oauthMeta) {
      const userScopes = new Set<string>(Object.values(TELEGRAM_USER_SCOPES));
      nextOauthMeta = {
        ...oauthMeta,
        granted_scopes: oauthMeta.granted_scopes.filter((s) => !userScopes.has(s)),
      };
    }
    // `connected` should stay true if the bot is still connected. We derive it
    // from whether any granted scopes remain.
    const stillConnected = (nextOauthMeta?.granted_scopes.length ?? 0) > 0;
    return {
      ...prev,
      connected: stillConnected,
      services,
      oauthMeta: nextOauthMeta,
    };
  });
}

/**
 * Disconnect: delete the token + clear connected flag + granted scopes.
 * User config (poll interval, defaultParseMode) is preserved so a reconnect
 * doesn't wipe preferences.
 */
export async function disconnectBot(): Promise<void> {
  await getSecretsStore().delete("telegram", BOT_TOKEN_KEY);
  await mutateState("telegram", (prev) => {
    const services = { ...prev.services };
    const existing = services["bot"];
    if (existing) {
      const nextConfig = { ...(existing.config ?? {}) };
      delete nextConfig.botInfo;
      services["bot"] = {
        ...existing,
        config: nextConfig,
      };
    }
    return {
      ...prev,
      connected: false,
      services,
      oauthMeta: undefined,
      lastError: undefined,
    };
  });
}
