import type { IntegrationManifest } from "../../types";

// Telegram integration manifest.
//
// Unlike GSuite, Telegram doesn't use OAuth. The MVP (Phase 1) ships with a
// single BOT service that authenticates via a bot token (obtained from
// @BotFather) — this matches spec `user-specs/telegram-integration/spec.md`
// FR-1 "bot token" branch. The USER service is declared for symmetry so the
// UI can surface a "coming soon" hint; its adapter throws `not_implemented`
// for every method (MTProto/api_id+api_hash lands in Phase 2).
//
// Scopes: Telegram bots don't have an OAuth scope concept, but the BOS
// framework gates every adapter call through `withScope`. We invent a small
// set of scope-ish permission strings (`telegram:bot.send`, `.read`, `.manage`)
// that map to categories of bot API surface. When the bot token is validated
// (`getMe` succeeds) we set `granted_scopes` to the full BOT set. The scope
// toggles in the UI let the user disable send/manage independently from read.

export const TELEGRAM_BOT_SCOPES = {
  read: "telegram:bot.read",
  send: "telegram:bot.send",
  manage: "telegram:bot.manage",
} as const;

export const TELEGRAM_USER_SCOPES = {
  read: "telegram:user.read",
  send: "telegram:user.send",
} as const;

const ALL_SCOPES: string[] = [
  ...Object.values(TELEGRAM_BOT_SCOPES),
  ...Object.values(TELEGRAM_USER_SCOPES),
];

export const TELEGRAM_MANIFEST: IntegrationManifest = {
  id: "telegram",
  name: "Telegram",
  version: "1.0.0",
  description:
    "Telegram Bot API integration — send messages, media, and receive updates via long-poll or webhook. User-account (MTProto) support is planned for Phase 2.",
  icon: "Send",
  // Telegram doesn't use OAuth. The framework insists on an `oauthConfig`
  // block, but connect/disconnect for this integration go through the
  // Telegram-specific `/api/integrations/telegram/bot/*` routes and never
  // touch these URLs. Placeholder values point at Telegram's help pages so
  // an operator inspecting state won't be confused.
  oauthConfig: {
    authorizationUrl: "https://core.telegram.org/bots#creating-a-new-bot",
    tokenUrl: "https://core.telegram.org/bots#creating-a-new-bot",
    supportedScopes: ALL_SCOPES,
  },
  services: [
    {
      id: "bot",
      name: "Bot",
      description:
        "Send / receive messages via a Telegram Bot (@BotFather token). Rate-limited and queued when offline.",
      icon: "Bot",
      scopes: [
        TELEGRAM_BOT_SCOPES.read,
        TELEGRAM_BOT_SCOPES.send,
        TELEGRAM_BOT_SCOPES.manage,
      ],
      configSchema: {
        type: "object",
        properties: {
          poll: {
            type: "object",
            description:
              "Long-poll configuration. Calls getUpdates on an interval. See scheduler/types.ts for shape.",
            properties: {
              enabled: { type: "boolean", default: true },
              intervalSec: { type: "number", default: 30 },
            },
          },
          webhook: {
            type: "object",
            description:
              "Webhook configuration. Set enabled=true to disable polling and let Telegram push updates. Requires a publicly reachable HTTPS URL — see docs/usage/integrations/telegram.md.",
            properties: {
              enabled: { type: "boolean", default: false },
              secretToken: {
                type: "string",
                description:
                  "Optional shared secret. When set, Telegram echoes it in the X-Telegram-Bot-Api-Secret-Token header and the receiver rejects requests without a match.",
              },
              allowedUpdates: {
                type: "array",
                items: { type: "string" },
                default: [],
                description:
                  "Update types to receive (see https://core.telegram.org/bots/api#update). Empty means default set.",
              },
            },
          },
          defaultParseMode: {
            type: "string",
            enum: ["MarkdownV2", "HTML", ""],
            default: "MarkdownV2",
            description:
              "Default parse_mode applied when messages_send is called without one. Empty = plain text.",
          },
        },
      },
    },
    {
      id: "user",
      name: "User account (MTProto)",
      description:
        "Send / receive messages as a user account via api_id + api_hash. Planned for Phase 2 — currently returns not_implemented for every action.",
      icon: "User",
      scopes: [TELEGRAM_USER_SCOPES.read, TELEGRAM_USER_SCOPES.send],
      configSchema: {
        type: "object",
        properties: {
          apiId: {
            type: "string",
            default: "",
            description:
              "Numeric api_id from my.telegram.org (Phase 2 — not yet used).",
          },
          apiHash: {
            type: "string",
            default: "",
            description:
              "api_hash from my.telegram.org (Phase 2 — not yet used).",
          },
          phone: {
            type: "string",
            default: "",
            description:
              "Phone number in international format used for the login code flow (Phase 2).",
          },
        },
      },
    },
  ],
};
