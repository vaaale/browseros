// Framework-free method metadata for GmailAdapter. Split out of gmail.ts
// (which is `server-only`) so the CLIENT dispatcher can walk this list to
// register CopilotKit actions without pulling in Node/Google APIs.
//
// The metadata here does NOT include the `invoke` closure — that lives with
// the adapter in gmail.ts and is only used server-side by the invoke route
// (see actions/adapter-registry.ts).
//
// Method ids follow the BOS `<object>_<verb>` snake_case tool-naming standard
// (see capabilities-registry.ts). The GmailAdapter TS class methods stay in
// camelCase (`listMessages`, `sendMessage`, …) — the invoker map in `gmail.ts`
// bridges tool id → adapter method.

import { GMAIL_SCOPES } from "../manifest";
import type { AdapterMethodParameter } from "../../../actions/types";

export type GmailMethodName =
  | "messages_list"
  | "messages_get"
  | "messages_send"
  | "messages_reply"
  | "messages_modify"
  | "messages_trash"
  | "messages_untrash"
  | "messages_search"
  | "messages_download_attachment"
  | "labels_list"
  | "labels_get"
  | "profile_get";

export interface GmailMethodDescriptor {
  method: GmailMethodName;
  scope: string;
  description: string;
  parameters: AdapterMethodParameter[];
}

// One descriptor per adapter method. Keep IN SYNC with GMAIL_METHODS in
// gmail.ts — the server-side list adds an `invoke` closure on top of these
// fields.
export const GMAIL_METHOD_DESCRIPTORS: readonly GmailMethodDescriptor[] = [
  {
    method: "messages_list",
    scope: GMAIL_SCOPES.readonly,
    description:
      "List Gmail message ids for the authenticated user. Optional Gmail search `query` (e.g. 'is:unread newer_than:7d'), `labelIds`, `maxResults`, and `pageToken`.",
    parameters: [
      { name: "query", type: "string", description: "Gmail search query. Same syntax as the Gmail search box.", required: false },
      { name: "labelIds", type: "string[]", description: "Filter by label id (e.g. INBOX, STARRED).", required: false },
      { name: "maxResults", type: "number", description: "Max results per page (default 100, cap 500).", required: false },
      { name: "pageToken", type: "string", description: "Next page token from a previous call.", required: false },
      { name: "includeSpamTrash", type: "boolean", description: "Include SPAM and TRASH.", required: false },
    ],
  },
  {
    method: "messages_get",
    scope: GMAIL_SCOPES.readonly,
    description:
      "Fetch a single Gmail message by id and return it as a markdown document: headers (From/To/Subject/Date/labels), the body (text/plain preferred, text/html downgraded to markdown otherwise), and — if present — an attachment table with `filename` and `id` columns. The `id` column contains the short `partId` (e.g. `1`, `1.2`); pass it verbatim as `attachmentId` to `gmail_messages_download_attachment` and the server resolves it to Gmail's underlying attachment id.",
    parameters: [
      { name: "id", type: "string", description: "The Gmail message id.", required: true },
    ],
  },
  {
    method: "messages_send",
    scope: GMAIL_SCOPES.send,
    description: "Send a Gmail message. Defaults to text/plain; pass mimeType='text/html' for rich content.",
    parameters: [
      { name: "to", type: "string", description: "Recipient email address(es), comma-separated.", required: true },
      { name: "subject", type: "string", description: "Message subject.", required: true },
      { name: "body", type: "string", description: "Message body.", required: true },
      { name: "cc", type: "string", description: "Cc addresses, comma-separated.", required: false },
      { name: "bcc", type: "string", description: "Bcc addresses, comma-separated.", required: false },
      { name: "replyTo", type: "string", description: "Reply-To address override.", required: false },
      { name: "mimeType", type: "string", description: "'text/plain' (default) or 'text/html'.", required: false },
    ],
  },
  {
    method: "messages_reply",
    scope: GMAIL_SCOPES.send,
    description: "Reply in-thread to an existing Gmail message. Threading + Re: prefix are handled automatically.",
    parameters: [
      { name: "messageId", type: "string", description: "The Gmail message id to reply to.", required: true },
      { name: "body", type: "string", description: "Reply body.", required: true },
      { name: "mimeType", type: "string", description: "'text/plain' (default) or 'text/html'.", required: false },
    ],
  },
  {
    method: "messages_modify",
    scope: GMAIL_SCOPES.modify,
    description: "Add or remove labels on a Gmail message. Common labels: INBOX, UNREAD, STARRED, IMPORTANT.",
    parameters: [
      { name: "id", type: "string", description: "The Gmail message id.", required: true },
      { name: "addLabelIds", type: "string[]", description: "Labels to add.", required: false },
      { name: "removeLabelIds", type: "string[]", description: "Labels to remove.", required: false },
    ],
  },
  {
    method: "messages_trash",
    scope: GMAIL_SCOPES.modify,
    description: "Move a Gmail message to Trash. Reversible via messages_untrash.",
    parameters: [{ name: "id", type: "string", description: "The Gmail message id.", required: true }],
  },
  {
    method: "messages_untrash",
    scope: GMAIL_SCOPES.modify,
    description: "Restore a Gmail message from Trash.",
    parameters: [{ name: "id", type: "string", description: "The Gmail message id.", required: true }],
  },
  {
    method: "messages_search",
    scope: GMAIL_SCOPES.readonly,
    description:
      "Search Gmail with Google's operator syntax. Examples: 'from:foo@example.com', 'has:attachment', 'newer_than:7d'.",
    parameters: [
      { name: "query", type: "string", description: "Gmail search query.", required: true },
      { name: "maxResults", type: "number", description: "Max results per page.", required: false },
      { name: "pageToken", type: "string", description: "Next page token.", required: false },
    ],
  },
  {
    method: "messages_download_attachment",
    scope: GMAIL_SCOPES.readonly,
    description:
      "Download a Gmail message attachment and save it to the BOS virtual file system under /Documents/Emails. Accepts either the short `partId` shown in the `messages_get` attachment table (e.g. `1`, `1.2`) or the raw Gmail `attachmentId` — the server resolves either to the underlying part. The filename comes from the attachment's part on the parent message; collisions are avoided by appending a short message-id suffix. Returns { path, size, mimeType }; over 50 MB returns { error: 'too_large', size, maxBytes }.",
    parameters: [
      { name: "messageId", type: "string", description: "The Gmail message id containing the attachment.", required: true },
      { name: "attachmentId", type: "string", description: "Either the short `partId` from the `messages_get` attachment table (e.g. `1`, `1.2`) or the raw Gmail attachment id (`payload.parts[].body.attachmentId`). Both are accepted.", required: true },
    ],
  },
  {
    method: "labels_list",
    scope: GMAIL_SCOPES.readonly,
    description: "List all Gmail labels (system + user).",
    parameters: [],
  },
  {
    method: "labels_get",
    scope: GMAIL_SCOPES.readonly,
    description: "Fetch a single Gmail label by id.",
    parameters: [{ name: "id", type: "string", description: "Label id (e.g. INBOX or a user label id).", required: true }],
  },
  {
    method: "profile_get",
    scope: GMAIL_SCOPES.readonly,
    description: "Fetch the authenticated user's Gmail profile (emailAddress, message/thread counts, historyId).",
    parameters: [],
  },
];
