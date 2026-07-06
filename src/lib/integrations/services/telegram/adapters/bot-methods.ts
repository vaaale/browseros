// Framework-free method metadata for TelegramBotAdapter. Split out of
// `bot.ts` (server-only) so the CLIENT dispatcher can walk this list to
// register CopilotKit actions without pulling in Node.
//
// Method ids follow the `<object>_<verb>` snake_case standard shared with
// GSuite. Descriptions include enough context that the LLM can plan a call
// without reading Bot API docs.

import type { AdapterMethodParameter } from "../../../actions/types";
import { TELEGRAM_BOT_SCOPES } from "../manifest";

export type BotMethodName =
  | "bot_get_me"
  | "messages_send"
  | "messages_send_photo"
  | "messages_send_document"
  | "messages_reply"
  | "messages_forward"
  | "messages_delete"
  | "messages_edit"
  | "chats_pin_message"
  | "chats_unpin_message"
  | "chats_get"
  | "bot_answer_callback"
  | "bot_set_commands"
  | "updates_get"
  | "agent_route_message";

export interface BotMethodDescriptor {
  method: BotMethodName;
  scope: string;
  description: string;
  parameters: AdapterMethodParameter[];
}

export const TELEGRAM_BOT_METHOD_DESCRIPTORS: readonly BotMethodDescriptor[] = [
  {
    method: "bot_get_me",
    scope: TELEGRAM_BOT_SCOPES.read,
    description:
      "Return the bot's own profile (id, username, first_name). Useful to confirm the token is still valid.",
    parameters: [],
  },
  {
    method: "messages_send",
    scope: TELEGRAM_BOT_SCOPES.send,
    description:
      "Send a text message to a Telegram chat. `chatId` accepts a numeric id (positive for users/bots, negative for groups) or an @username (public channels/groups). `parseMode` defaults to the service's `defaultParseMode` config. If the network is offline the send is queued.",
    parameters: [
      { name: "chatId", type: "string", description: "Target chat id (numeric or @username).", required: true },
      { name: "text", type: "string", description: "Message text. Max 4096 chars.", required: true },
      { name: "parseMode", type: "string", description: "'MarkdownV2', 'HTML', or '' for plain text. Defaults to the bot service's `defaultParseMode`.", required: false },
      { name: "disableWebPagePreview", type: "boolean", description: "Suppress link previews.", required: false },
      { name: "disableNotification", type: "boolean", description: "Send silently.", required: false },
      { name: "replyToMessageId", type: "number", description: "Message id being replied to (for threading).", required: false },
    ],
  },
  {
    method: "messages_send_photo",
    scope: TELEGRAM_BOT_SCOPES.send,
    description:
      "Send a photo to a Telegram chat. Provide either `url` (Telegram fetches it), `fileId` (reuse a previously uploaded file), or `path` (BOS VFS or absolute path — the file is uploaded multipart). Max 10 MB via URL / file_id; larger files must use `path`.",
    parameters: [
      { name: "chatId", type: "string", description: "Target chat id.", required: true },
      { name: "url", type: "string", description: "Public URL Telegram will fetch. Mutually exclusive with fileId/path.", required: false },
      { name: "fileId", type: "string", description: "Cached file_id from a previous send. Mutually exclusive with url/path.", required: false },
      { name: "path", type: "string", description: "BOS VFS path (`/Documents/...`) or absolute filesystem path to upload.", required: false },
      { name: "caption", type: "string", description: "Optional caption (max 1024 chars).", required: false },
      { name: "parseMode", type: "string", description: "Parse mode for the caption.", required: false },
      { name: "replyToMessageId", type: "number", description: "Message id being replied to.", required: false },
    ],
  },
  {
    method: "messages_send_document",
    scope: TELEGRAM_BOT_SCOPES.send,
    description:
      "Send an arbitrary file (PDF, ZIP, txt, etc.) to a Telegram chat. Same `url` / `fileId` / `path` semantics as `messages_send_photo`. Max 50 MB by URL/file_id; 2 GB via path (multipart).",
    parameters: [
      { name: "chatId", type: "string", description: "Target chat id.", required: true },
      { name: "url", type: "string", description: "Public URL to the file.", required: false },
      { name: "fileId", type: "string", description: "Cached file_id.", required: false },
      { name: "path", type: "string", description: "BOS VFS path or absolute filesystem path to upload.", required: false },
      { name: "caption", type: "string", description: "Optional caption.", required: false },
      { name: "parseMode", type: "string", description: "Parse mode for the caption.", required: false },
      { name: "replyToMessageId", type: "number", description: "Message id being replied to.", required: false },
    ],
  },
  {
    method: "messages_reply",
    scope: TELEGRAM_BOT_SCOPES.send,
    description:
      "Reply to a specific message in a chat. Equivalent to `messages_send` with `replyToMessageId` set — provided as a distinct action so the LLM can pick the intent-clear form.",
    parameters: [
      { name: "chatId", type: "string", description: "Target chat id.", required: true },
      { name: "messageId", type: "number", description: "The message id being replied to.", required: true },
      { name: "text", type: "string", description: "Reply text.", required: true },
      { name: "parseMode", type: "string", description: "Parse mode.", required: false },
    ],
  },
  {
    method: "messages_forward",
    scope: TELEGRAM_BOT_SCOPES.send,
    description:
      "Forward a message from one chat to another. Bot must be a member of the source chat (or the source must be public).",
    parameters: [
      { name: "toChatId", type: "string", description: "Destination chat id.", required: true },
      { name: "fromChatId", type: "string", description: "Source chat id.", required: true },
      { name: "messageId", type: "number", description: "Source message id.", required: true },
      { name: "disableNotification", type: "boolean", description: "Send silently.", required: false },
    ],
  },
  {
    method: "messages_delete",
    scope: TELEGRAM_BOT_SCOPES.manage,
    description:
      "Delete a message. Bots can delete their own outgoing messages any time; deleting others' messages requires the bot to be a chat administrator with the `can_delete_messages` privilege.",
    parameters: [
      { name: "chatId", type: "string", description: "Chat id containing the message.", required: true },
      { name: "messageId", type: "number", description: "Message id to delete.", required: true },
    ],
  },
  {
    method: "messages_edit",
    scope: TELEGRAM_BOT_SCOPES.send,
    description:
      "Edit the text of a previously sent bot message. Only messages sent by the bot itself can be edited.",
    parameters: [
      { name: "chatId", type: "string", description: "Chat id containing the message.", required: true },
      { name: "messageId", type: "number", description: "Message id to edit.", required: true },
      { name: "text", type: "string", description: "New text.", required: true },
      { name: "parseMode", type: "string", description: "Parse mode.", required: false },
      { name: "disableWebPagePreview", type: "boolean", description: "Suppress link previews.", required: false },
    ],
  },
  {
    method: "chats_pin_message",
    scope: TELEGRAM_BOT_SCOPES.manage,
    description:
      "Pin a message to the top of a chat. Requires the bot to be an admin in the chat (or a group creator).",
    parameters: [
      { name: "chatId", type: "string", description: "Target chat id.", required: true },
      { name: "messageId", type: "number", description: "Message id to pin.", required: true },
      { name: "disableNotification", type: "boolean", description: "Pin without pushing a notification.", required: false },
    ],
  },
  {
    method: "chats_unpin_message",
    scope: TELEGRAM_BOT_SCOPES.manage,
    description:
      "Unpin a specific pinned message. If `messageId` is omitted, unpins the most recent pinned message.",
    parameters: [
      { name: "chatId", type: "string", description: "Target chat id.", required: true },
      { name: "messageId", type: "number", description: "Message id to unpin (omit to unpin most recent).", required: false },
    ],
  },
  {
    method: "chats_get",
    scope: TELEGRAM_BOT_SCOPES.read,
    description:
      "Fetch a chat's public profile (title, type, description, members count for groups, permissions, etc.). Bot must be a member of the chat.",
    parameters: [
      { name: "chatId", type: "string", description: "Target chat id.", required: true },
    ],
  },
  {
    method: "bot_answer_callback",
    scope: TELEGRAM_BOT_SCOPES.send,
    description:
      "Acknowledge a callback query from an inline keyboard button. Optionally show a text/alert to the user. Should be called quickly (< 10 s) after receiving the callback_query update.",
    parameters: [
      { name: "callbackQueryId", type: "string", description: "The callback_query.id from the received update.", required: true },
      { name: "text", type: "string", description: "Notification text (max 200 chars).", required: false },
      { name: "showAlert", type: "boolean", description: "Show as an alert dialog instead of a toast.", required: false },
    ],
  },
  {
    method: "bot_set_commands",
    scope: TELEGRAM_BOT_SCOPES.manage,
    description:
      "Register the bot's slash-command menu. `commands` is a list of { command, description } — the Telegram app renders it in the / attach menu.",
    parameters: [
      {
        name: "commands",
        type: "object[]",
        description: "List of { command: string, description: string }. Command names 1–32 chars, lower-case letters/digits/underscore only.",
        required: true,
      },
    ],
  },
  {
    method: "updates_get",
    scope: TELEGRAM_BOT_SCOPES.read,
    description:
      "Fetch pending updates via long-poll (`getUpdates`). Used by the background poller — direct invocation is fine for debugging but the scheduler already handles the update loop.",
    parameters: [
      { name: "offset", type: "number", description: "Only return updates with id >= offset. Pass previous max+1 to ack.", required: false },
      { name: "limit", type: "number", description: "Cap on returned updates (1–100).", required: false },
      { name: "timeout", type: "number", description: "Long-poll seconds (0–50). Default 0 (short-poll).", required: false },
    ],
  },
  {
    method: "agent_route_message",
    scope: TELEGRAM_BOT_SCOPES.send,
    description:
      "Route a message through the configured Telegram sub-agent and post its reply back to the chat. Uses the same rolling context store as the auto-reply poller, so this call is transparent to on-going conversations. Useful for testing an agent's behaviour or wiring a one-off message into the reply pipeline.",
    parameters: [
      { name: "chatId", type: "string", description: "Chat id whose context to use and where to send the reply.", required: true },
      { name: "text", type: "string", description: "The message text to route (as if the chat participant sent it).", required: true },
      { name: "agentId", type: "string", description: "Override the configured agent for this call. Defaults to the bot service's agentConfig.agentId.", required: false },
      { name: "contextDepth", type: "number", description: "How many prior turns to include. Defaults to the configured contextDepth.", required: false },
    ],
  },
];
