import "server-only";
import { IntegrationAuthError, IntegrationConfigError } from "../../errors";
import { getSecretsStore } from "../../secrets/store";
import { mutateState } from "../../state/store";
import { telegramFetch } from "./client";
import { TELEGRAM_BOT_SCOPES } from "./manifest";

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
