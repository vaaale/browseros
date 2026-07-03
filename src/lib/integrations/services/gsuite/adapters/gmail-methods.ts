// Framework-free method metadata for GmailAdapter. Split out of gmail.ts
// (which is `server-only`) so the CLIENT dispatcher can walk this list to
// register CopilotKit actions without pulling in Node/Google APIs.
//
// The metadata here does NOT include the `invoke` closure — that lives with
// the adapter in gmail.ts and is only used server-side by the invoke route
// (see actions/adapter-registry.ts).

import { GMAIL_SCOPES } from "../manifest";
import type { AdapterMethodParameter } from "../../../actions/types";

export type GmailMethodName =
  | "listMessages"
  | "getMessage"
  | "sendMessage"
  | "replyToMessage"
  | "modifyMessage"
  | "trashMessage"
  | "untrashMessage"
  | "searchMessages"
  | "listLabels"
  | "getLabel"
  | "getProfile";

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
    method: "listMessages",
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
    method: "getMessage",
    scope: GMAIL_SCOPES.readonly,
    description:
      "Fetch a single Gmail message by id. Use `format=metadata` with `metadataHeaders` to fetch only headers you need.",
    parameters: [
      { name: "id", type: "string", description: "The Gmail message id.", required: true },
      { name: "format", type: "string", description: "'full' | 'metadata' | 'minimal' | 'raw'. Defaults to 'full'.", required: false },
      { name: "metadataHeaders", type: "string[]", description: "Headers to include when format=metadata (e.g. Subject, From).", required: false },
    ],
  },
  {
    method: "sendMessage",
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
    method: "replyToMessage",
    scope: GMAIL_SCOPES.send,
    description: "Reply in-thread to an existing Gmail message. Threading + Re: prefix are handled automatically.",
    parameters: [
      { name: "messageId", type: "string", description: "The Gmail message id to reply to.", required: true },
      { name: "body", type: "string", description: "Reply body.", required: true },
      { name: "mimeType", type: "string", description: "'text/plain' (default) or 'text/html'.", required: false },
    ],
  },
  {
    method: "modifyMessage",
    scope: GMAIL_SCOPES.modify,
    description: "Add or remove labels on a Gmail message. Common labels: INBOX, UNREAD, STARRED, IMPORTANT.",
    parameters: [
      { name: "id", type: "string", description: "The Gmail message id.", required: true },
      { name: "addLabelIds", type: "string[]", description: "Labels to add.", required: false },
      { name: "removeLabelIds", type: "string[]", description: "Labels to remove.", required: false },
    ],
  },
  {
    method: "trashMessage",
    scope: GMAIL_SCOPES.modify,
    description: "Move a Gmail message to Trash. Reversible via untrashMessage.",
    parameters: [{ name: "id", type: "string", description: "The Gmail message id.", required: true }],
  },
  {
    method: "untrashMessage",
    scope: GMAIL_SCOPES.modify,
    description: "Restore a Gmail message from Trash.",
    parameters: [{ name: "id", type: "string", description: "The Gmail message id.", required: true }],
  },
  {
    method: "searchMessages",
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
    method: "listLabels",
    scope: GMAIL_SCOPES.readonly,
    description: "List all Gmail labels (system + user).",
    parameters: [],
  },
  {
    method: "getLabel",
    scope: GMAIL_SCOPES.readonly,
    description: "Fetch a single Gmail label by id.",
    parameters: [{ name: "id", type: "string", description: "Label id (e.g. INBOX or a user label id).", required: true }],
  },
  {
    method: "getProfile",
    scope: GMAIL_SCOPES.readonly,
    description: "Fetch the authenticated user's Gmail profile (emailAddress, message/thread counts, historyId).",
    parameters: [],
  },
];
