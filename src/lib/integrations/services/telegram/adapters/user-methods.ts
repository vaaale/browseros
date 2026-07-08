// Framework-free method metadata for the MTProto Telegram User service. The
// LLM sees each descriptor as an available action; the adapter (server-only)
// backs each one with a gramjs call. Names follow the shared
// `<object>_<verb>` convention — `telegram_` prefixes are added by the
// dispatcher when it composes the CopilotKit action name.

import type { AdapterMethodParameter } from "../../../actions/types";
import { TELEGRAM_USER_SCOPES } from "../manifest";

export type UserMethodName =
  | "user_send_message"
  | "user_list_contacts"
  | "user_list_chats"
  | "user_get_chat_history"
  | "user_search_messages"
  | "user_mute_chat"
  | "user_unmute_chat"
  | "user_archive_chat"
  | "user_unarchive_chat"
  | "user_pin_chat"
  | "user_unpin_chat";

export interface UserMethodDescriptor {
  method: UserMethodName;
  scope: string;
  description: string;
  parameters: AdapterMethodParameter[];
}

export const TELEGRAM_USER_METHOD_DESCRIPTORS: readonly UserMethodDescriptor[] = [
  {
    method: "user_send_message",
    scope: TELEGRAM_USER_SCOPES.send,
    description:
      "Send a message from the connected Telegram user account. `chatId` accepts a numeric id, @username, or 'me' for Saved Messages. Optional `replyToMessageId` threads the reply.",
    parameters: [
      { name: "chatId", type: "string", description: "Target chat id, @username, or 'me'.", required: true },
      { name: "text", type: "string", description: "Message body (max 4096 chars).", required: true },
      { name: "replyToMessageId", type: "number", description: "Message id being replied to (optional).", required: false },
    ],
  },
  {
    method: "user_list_contacts",
    scope: TELEGRAM_USER_SCOPES.read,
    description:
      "Return the user's Telegram contact list (people saved in their address book). Reads from a 30-minute cache; pass `refresh: true` to force a live fetch.",
    parameters: [
      { name: "refresh", type: "boolean", description: "Force a live MTProto fetch instead of the cache.", required: false },
    ],
  },
  {
    method: "user_list_chats",
    scope: TELEGRAM_USER_SCOPES.read,
    description:
      "List the user's chats (dialogs) with last-message preview, unread count, pin/mute/archive state. Cached for 30 minutes; pass `refresh: true` to force a fresh MTProto call. Optional `archived` filter.",
    parameters: [
      { name: "refresh", type: "boolean", description: "Force a live fetch.", required: false },
      { name: "archived", type: "boolean", description: "Only return archived chats (defaults to non-archived).", required: false },
      { name: "limit", type: "number", description: "Max entries (default 100, max 500).", required: false },
    ],
  },
  {
    method: "user_get_chat_history",
    scope: TELEGRAM_USER_SCOPES.read,
    description:
      "Fetch recent messages from a specific chat. Pagination via `offsetId` (message id to page backwards from) and `limit` (default 50, max 100). Fetched messages are added to the local FTS index.",
    parameters: [
      { name: "chatId", type: "string", description: "Target chat id or @username.", required: true },
      { name: "limit", type: "number", description: "Batch size, default 50, max 100.", required: false },
      { name: "offsetId", type: "number", description: "Only messages older than this id (for paging).", required: false },
    ],
  },
  {
    method: "user_search_messages",
    scope: TELEGRAM_USER_SCOPES.read,
    description:
      "Full-text search across the local Telegram message index (built from getChatHistory calls). Supports optional filters: chatId, senderId, since/until epoch seconds, limit.",
    parameters: [
      { name: "query", type: "string", description: "Free-form search terms.", required: true },
      { name: "chatId", type: "string", description: "Restrict to one chat.", required: false },
      { name: "senderId", type: "string", description: "Restrict to one sender.", required: false },
      { name: "since", type: "number", description: "Epoch seconds — messages on/after.", required: false },
      { name: "until", type: "number", description: "Epoch seconds — messages on/before.", required: false },
      { name: "limit", type: "number", description: "Max results (default 50, max 500).", required: false },
    ],
  },
  {
    method: "user_mute_chat",
    scope: TELEGRAM_USER_SCOPES.send,
    description:
      "Mute notifications for a chat (locally + server-side via MTProto). Optional `hours` sets a temporary mute (default is indefinite).",
    parameters: [
      { name: "chatId", type: "string", description: "Target chat id or @username.", required: true },
      { name: "hours", type: "number", description: "Mute duration in hours; 0 or omitted = forever.", required: false },
    ],
  },
  {
    method: "user_unmute_chat",
    scope: TELEGRAM_USER_SCOPES.send,
    description: "Remove a mute from a chat.",
    parameters: [
      { name: "chatId", type: "string", description: "Target chat id or @username.", required: true },
    ],
  },
  {
    method: "user_archive_chat",
    scope: TELEGRAM_USER_SCOPES.send,
    description: "Move a chat to the Archive folder.",
    parameters: [
      { name: "chatId", type: "string", description: "Target chat id or @username.", required: true },
    ],
  },
  {
    method: "user_unarchive_chat",
    scope: TELEGRAM_USER_SCOPES.send,
    description: "Restore a chat from the Archive folder.",
    parameters: [
      { name: "chatId", type: "string", description: "Target chat id or @username.", required: true },
    ],
  },
  {
    method: "user_pin_chat",
    scope: TELEGRAM_USER_SCOPES.send,
    description: "Pin a chat to the top of the chat list.",
    parameters: [
      { name: "chatId", type: "string", description: "Target chat id or @username.", required: true },
    ],
  },
  {
    method: "user_unpin_chat",
    scope: TELEGRAM_USER_SCOPES.send,
    description: "Unpin a previously pinned chat.",
    parameters: [
      { name: "chatId", type: "string", description: "Target chat id or @username.", required: true },
    ],
  },
];
