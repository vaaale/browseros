# Telegram

The **Telegram integration** connects BrowserOS to a Telegram **bot** so the
assistant can send messages, share files, and react to updates from your chats
without leaving the OS. Ask *"post the meeting notes to the #ops group"* or
*"reply to Alice's last message with a thumbs-up"* and the assistant routes
the call through your bot.

You are in control of what BOS can see: the integration is **off** until you
paste a bot token, and every category of Bot API surface (read / send / manage)
is individually revocable from Settings.

---

## Overview

Once connected, Telegram adds one service the assistant can call today:

| Service                    | What the assistant can do today                                                                                       | Status                                     |
|----------------------------|----------------------------------------------------------------------------------------------------------------------|--------------------------------------------|
| **Bot**                    | Send text / photos / documents, reply, forward, edit, delete, pin, answer callback queries, set command menu, fetch updates. | Full (Phase 1)                             |
| **User account (MTProto)** | Surfaces in the UI so scopes can be granted ahead of time.                                                            | Coming — api_id + api_hash flow in Phase 2 |

On top of the on-demand tools, the bot can also **push** into BOS:

- **Polling** — a background scheduler asks Telegram for new updates on an
  interval (default every 30 s) and drops each new message / callback into
  the **Notifications** inbox.
- **Webhooks** — Telegram POSTs updates to BOS the instant they happen. Faster
  than polling, but requires a publicly reachable HTTPS URL.

Both mechanisms produce the exact same `telegram_message` / `telegram_callback_query`
events, so downstream consumers (Dock badge, notification agent, custom skills)
don't care which mode is active.

---

## Prerequisites

To connect Telegram you need one thing:

1. A **bot token** from [@BotFather](https://t.me/BotFather).
   - Send `/newbot` and follow the prompts, or `/mybots → API Token` for an
     existing bot.
   - Tokens look like `123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`.
2. The bot must be **added to any chat** you want it to post in (Telegram
   requires this — a bot can't message a chat it isn't a member of). For DMs,
   the recipient must start a conversation with the bot first.

Optional but recommended:

- To **pin messages** or **delete** other people's messages, the bot must be a
  **chat admin** with the corresponding privilege.
- To **use webhooks**, BOS must be reachable at an HTTPS URL Telegram can
  POST to. Set `NEXT_PUBLIC_APP_ORIGIN=https://your.domain` in your `.env`
  before enabling webhooks.

---

## Connect

1. Open **Settings → Integrations → Telegram**.
2. Paste your bot token into the **Bot token** field and click **Connect**.
   BOS calls `getMe` to validate the token and stores it encrypted in the
   SecretsStore.
3. You should see **Connected as @your-bot-name**. Click into the **Bot**
   service to configure polling, webhooks, and the offline queue.

The token is stored under `data/integrations/secrets.json` (AES-256-GCM,
key at `data/.integrations-key`). It never leaves BOS.

To disconnect, click **Disconnect** on the auth card — the token is deleted,
`connected` flips to false, but your poll / webhook / parse-mode settings are
preserved so reconnecting picks up where you left off.

---

## Scopes

Bots don't have OAuth scopes. BOS invents three permission categories that
gate adapter methods internally so you can disable subsets from the UI:

| Scope                  | Methods gated                                                                                          |
|------------------------|---------------------------------------------------------------------------------------------------------|
| `telegram:bot.read`    | `bot_get_me`, `chats_get`, `updates_get`                                                                |
| `telegram:bot.send`    | `messages_send`, `messages_send_photo`, `messages_send_document`, `messages_reply`, `messages_forward`, `messages_edit`, `bot_answer_callback` |
| `telegram:bot.manage`  | `messages_delete`, `chats_pin_message`, `chats_unpin_message`, `bot_set_commands`                       |

Toggling a scope off from **Settings → Integrations → Telegram → Bot → Scopes**
takes effect immediately — the LLM stops seeing the disabled actions in its
tool list.

---

## Polling vs. Webhooks

Only one delivery mechanism can be active at a time. Telegram itself enforces
this — `setWebhook` disables `getUpdates`, and vice-versa.

### Polling (default)

- Enabled by default with a 30-second interval.
- Tunable from **Bot → Polling** (30 s – 30 min).
- Reads the persistent `updateOffset` from state so restarts don't replay
  old updates.
- On failure, exponential backoff (starting at the poll interval, doubling
  up to 30 min) — the failure count and last error appear inline.

### Webhooks

- **Only enable if BOS is reachable at a public HTTPS URL** (Telegram refuses
  plain HTTP or private IPs).
- Toggle from **Bot → Webhook → Enable**. BOS calls `setWebhook` with:
  - `url = ${NEXT_PUBLIC_APP_ORIGIN}/api/integrations/webhooks/telegram/bot`
  - `secret_token` from `Bot service config → webhook → secretToken` (optional
    but strongly recommended — it goes in the `X-Telegram-Bot-Api-Secret-Token`
    header and the receiver rejects mismatches).
  - `allowed_updates` (optional): comma-separated list from the
    [Update spec](https://core.telegram.org/bots/api#update). Empty means
    default (skips `channel_post`, `edited_channel_post`, and a few others).
- Disable to switch back to polling — BOS calls `deleteWebhook` and the
  scheduler picks up updates again on the next tick.

---

## Offline queue

Sends that fail with a **transient** error (network down, Telegram 5xx after
retries) are automatically queued to disk under
`data/integrations/telegram/queue.json` and retried on the next poll tick
with exponential backoff (6 s → 25 min, up to 8 attempts).

- **Permanent** errors (Telegram 4xx: invalid chat id, banned by user,
  malformed markdown) are surfaced immediately and **not** queued.
- Multipart uploads (`sendPhoto` / `sendDocument` with a local `path`) are
  never queued — the file might not exist by retry time.
- The **Offline queue** section on the Bot service page shows every pending
  entry with its method, attempts, next retry, and last error. Buttons:
  **Flush now** (drain immediately), **Clear all** (discard), **×** per row
  (remove one).

---

## Rate limits

Telegram's Bot API caps individual bots at ~30 messages/second and returns
`429 Too Many Requests` with a `retry_after` when you exceed the limit. BOS
respects this transparently:

- A **per-token wait window** is tracked in memory. When Telegram tells us
  `retry_after: N`, subsequent sends block until the window elapses.
- The rate limiter is **reactive** — BOS doesn't proactively throttle. If
  your workload bursts hard enough to trip the limit, backoff kicks in
  automatically.

---

## Formatting

Text methods (`messages_send`, `messages_edit`, `messages_reply`) accept a
`parseMode` argument:

- `MarkdownV2` (default) — Telegram's variant of markdown.
  See [formatting reference](https://core.telegram.org/bots/api#markdownv2-style).
- `HTML` — subset of HTML tags Telegram supports.
- `""` (empty) — plain text, no parsing.

The default is configurable at **Bot → Default parse mode** if MarkdownV2 is
awkward for your use case.

⚠ **MarkdownV2 requires escaping** many characters (`_ * [ ] ( ) ~ ` >   # + - = | { } . !`).
If Telegram rejects a message with `Bad Request: can't parse entities`, either
switch to `HTML` or set `parseMode: ""` for that call.

---

## Assistant workflow

Once connected, the assistant sees Bot API actions with descriptions like
*"Send a text message to a Telegram chat"*. Ask naturally:

- *"Send a summary of today's meeting to @team_ops."*
- *"Reply to Alice's last message with 'on it 👍'."*
- *"Post the file at /Documents/report.pdf to the #ops chat with the caption 'Q3 report'."*
- *"What's the latest message from @support_bot? Summarize it in one line."*

Behind the scenes each request maps to one of the `bot_get_me` /
`messages_send*` / `chats_*` adapter methods; scope + rate-limit + queue
handling is invisible to the LLM.

---

## Troubleshooting

**"Bot token doesn't match the expected @BotFather format"**
The token must look like `<numeric-id>:<35+ alphanumeric chars>`. Copy it
directly from BotFather — no extra whitespace.

**"Auth failed: 401 Unauthorized"**
Token was revoked or regenerated. Click **Disconnect** and paste the new token.

**"Bad Request: chat not found"**
The bot isn't a member of that chat. Add it, or (for DMs) ask the user to
`/start` the bot first.

**Webhook enabled but no updates arrive**
Check that:

1. `NEXT_PUBLIC_APP_ORIGIN` is set to your **public HTTPS** URL.
2. The receiver at `/api/integrations/webhooks/telegram/bot` is reachable
   from the public internet (curl it from a different network).
3. If you set `secretToken`, it matches the one saved in your bot config.
4. `Bot → Webhook → Enable` is on. When it's off the receiver 404s.

**Queue grows without draining**
Usually means Telegram is returning 4xx for every retry — check the "last
error" column. Fix the underlying issue (invalid chat id, missing scope) and
either **Flush now** or delete the affected entries.

---

## Out of scope (Phase 1)

The following belong to Telegram spec §Out of Scope or Phase 2:

- User-account (MTProto) messaging — coming in Phase 2 via `api_id` + `api_hash`.
- Voice / video calls.
- Telegram Stories.
- Telegram Payments / Mini Apps.
- Local full-text search across chat history (bots don't get read access to
  historical chat content — Telegram only pushes new updates).

Track progress in `specs/user-specs/telegram-integration/`.
