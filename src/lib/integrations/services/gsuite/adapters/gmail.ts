import "server-only";
import { ServiceAdapter } from "../../../adapters/base";
import { getService } from "../../../registry";
import { IntegrationConfigError } from "../../../errors";
import type { IntegrationEvent, ServiceDefinition } from "../../../types";
import type { AdapterMethodMeta } from "../../../actions/types";
import { gsuiteFetch } from "../client";
import { GMAIL_SCOPES } from "../manifest";
import { GMAIL_METHOD_DESCRIPTORS, type GmailMethodName } from "./gmail-methods";

// GmailAdapter — the surface every Gmail feature (chat action, poll job, UI)
// calls into. Every method:
//   1. Guards its own OAuth scope via `withScope(FULL_SCOPE_URL, ...)`.
//   2. Fetches via `gsuiteFetch` so 401/429/5xx retry + auth are centralised.
//   3. Returns a plain JSON shape — the action wrapper (dispatcher.ts) turns
//      the return value into a string for the LLM.
//
// Method metadata lives in `GMAIL_METHODS` at the bottom of the file — the
// dispatcher walks it to register one CopilotKit action per method (D4/D5).

const BASE = "https://gmail.googleapis.com/gmail/v1";

// --- Request / response types --------------------------------------------

export interface ListMessagesParams {
  query?: string;
  labelIds?: string[];
  maxResults?: number;
  pageToken?: string;
  includeSpamTrash?: boolean;
}
export interface MessageRef {
  id: string;
  threadId: string;
}
export interface ListMessagesResult {
  messages: MessageRef[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export type MessageFormat = "full" | "metadata" | "minimal" | "raw";

export interface GetMessageParams {
  id: string;
  format?: MessageFormat;
  metadataHeaders?: string[];
}
export interface GmailMessagePayloadHeader {
  name: string;
  value: string;
}
export interface GmailMessagePayload {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailMessagePayloadHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailMessagePayload[];
}
export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  sizeEstimate?: number;
  raw?: string;
  payload?: GmailMessagePayload;
}

export interface SendMessageParams {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  mimeType?: "text/plain" | "text/html";
}
export interface SendMessageResult {
  id: string;
  threadId: string;
  labelIds?: string[];
}

export interface ReplyToMessageParams {
  messageId: string;
  body: string;
  mimeType?: "text/plain" | "text/html";
}

export interface ModifyMessageParams {
  id: string;
  addLabelIds?: string[];
  removeLabelIds?: string[];
}

export interface SearchMessagesParams {
  query: string;
  maxResults?: number;
  pageToken?: string;
}

export interface GmailLabel {
  id: string;
  name: string;
  type?: "system" | "user";
  messageListVisibility?: string;
  labelListVisibility?: string;
  messagesTotal?: number;
  threadsTotal?: number;
}
export interface ListLabelsResult {
  labels: GmailLabel[];
}

export interface GmailProfile {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
}

export interface PollOnceParams {
  /** Only emit messages newer than this epoch-ms. Defaults to 24h ago. */
  since?: number;
  /** Cap on messages examined per invocation. */
  maxResults?: number;
}
export interface PollOnceResult {
  newMessages: number;
  events: IntegrationEvent[];
}

// --- Adapter -------------------------------------------------------------

const RFC2047 = (s: string): string => {
  // Only encode if the string has non-ASCII — cheaper AND avoids gratuitous
  // encoding of plain headers that Google shows verbatim.
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
};

function base64UrlEncode(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function buildRfc2822({
  to,
  subject,
  body,
  cc,
  bcc,
  replyTo,
  mimeType = "text/plain",
  headers: extraHeaders = {},
}: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  mimeType?: "text/plain" | "text/html";
  headers?: Record<string, string>;
}): string {
  const lines: string[] = [];
  lines.push(`To: ${to}`);
  if (cc) lines.push(`Cc: ${cc}`);
  if (bcc) lines.push(`Bcc: ${bcc}`);
  if (replyTo) lines.push(`Reply-To: ${replyTo}`);
  lines.push(`Subject: ${RFC2047(subject)}`);
  for (const [k, v] of Object.entries(extraHeaders)) {
    lines.push(`${k}: ${v}`);
  }
  lines.push("MIME-Version: 1.0");
  lines.push(`Content-Type: ${mimeType}; charset="UTF-8"`);
  lines.push("Content-Transfer-Encoding: 8bit");
  lines.push("");
  lines.push(body);
  return lines.join("\r\n");
}

function headerValue(msg: GmailMessage, name: string): string | undefined {
  const target = name.toLowerCase();
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === target)?.value;
}

function serviceDef(): ServiceDefinition {
  const svc = getService("gsuite", "gmail");
  if (!svc) {
    throw new IntegrationConfigError("Gmail service is not registered on the gsuite integration.", {
      integrationId: "gsuite",
    });
  }
  return svc;
}

export class GmailAdapter extends ServiceAdapter {
  constructor() {
    super("gsuite", serviceDef());
  }

  // ---- 1.8.1 listMessages -----------------------------------------------
  async listMessages(params: ListMessagesParams = {}): Promise<ListMessagesResult> {
    return this.withScope(GMAIL_SCOPES.readonly, async () => {
      const qs = new URLSearchParams();
      if (params.query) qs.set("q", params.query);
      if (params.pageToken) qs.set("pageToken", params.pageToken);
      if (typeof params.maxResults === "number") qs.set("maxResults", String(params.maxResults));
      if (params.includeSpamTrash) qs.set("includeSpamTrash", "true");
      for (const lid of params.labelIds ?? []) qs.append("labelIds", lid);
      const url = `${BASE}/users/me/messages${qs.toString() ? `?${qs.toString()}` : ""}`;
      const res = await gsuiteFetch<{
        messages?: MessageRef[];
        nextPageToken?: string;
        resultSizeEstimate?: number;
      }>(this, url);
      return {
        messages: res.messages ?? [],
        nextPageToken: res.nextPageToken,
        resultSizeEstimate: res.resultSizeEstimate,
      };
    });
  }

  // ---- 1.8.2 getMessage --------------------------------------------------
  async getMessage(params: GetMessageParams): Promise<GmailMessage> {
    return this.withScope(GMAIL_SCOPES.readonly, async () => {
      const qs = new URLSearchParams();
      if (params.format) qs.set("format", params.format);
      if (params.format === "metadata" && params.metadataHeaders) {
        for (const h of params.metadataHeaders) qs.append("metadataHeaders", h);
      }
      const url = `${BASE}/users/me/messages/${encodeURIComponent(params.id)}${qs.toString() ? `?${qs.toString()}` : ""}`;
      return gsuiteFetch<GmailMessage>(this, url);
    });
  }

  // ---- 1.8.3 sendMessage -------------------------------------------------
  async sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
    return this.withScope(GMAIL_SCOPES.send, async () => {
      const rfc2822 = buildRfc2822({
        to: params.to,
        subject: params.subject,
        body: params.body,
        cc: params.cc,
        bcc: params.bcc,
        replyTo: params.replyTo,
        mimeType: params.mimeType,
      });
      const raw = base64UrlEncode(rfc2822);
      const res = await gsuiteFetch<SendMessageResult>(this, `${BASE}/users/me/messages/send`, {
        method: "POST",
        body: JSON.stringify({ raw }),
      });
      return res;
    });
  }

  // ---- 1.8.4 replyToMessage ---------------------------------------------
  async replyToMessage(params: ReplyToMessageParams): Promise<SendMessageResult> {
    return this.withScope(GMAIL_SCOPES.send, async () => {
      // Fetch just the headers we need (Subject, Message-Id, References, From/To).
      const source = await gsuiteFetch<GmailMessage>(
        this,
        `${BASE}/users/me/messages/${encodeURIComponent(params.messageId)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Message-Id&metadataHeaders=References`,
      );
      const from = headerValue(source, "From") ?? "";
      const messageId = headerValue(source, "Message-Id");
      const prevReferences = headerValue(source, "References") ?? "";
      const originalSubject = headerValue(source, "Subject") ?? "";
      const replySubject = originalSubject.match(/^re:/i)
        ? originalSubject
        : `Re: ${originalSubject}`.trim();

      const extraHeaders: Record<string, string> = {};
      if (messageId) {
        extraHeaders["In-Reply-To"] = messageId;
        extraHeaders["References"] = prevReferences ? `${prevReferences} ${messageId}` : messageId;
      }
      const rfc2822 = buildRfc2822({
        to: from,
        subject: replySubject,
        body: params.body,
        mimeType: params.mimeType,
        headers: extraHeaders,
      });
      const raw = base64UrlEncode(rfc2822);
      return gsuiteFetch<SendMessageResult>(this, `${BASE}/users/me/messages/send`, {
        method: "POST",
        body: JSON.stringify({ raw, threadId: source.threadId }),
      });
    });
  }

  // ---- 1.8.5 modifyMessage ----------------------------------------------
  async modifyMessage(params: ModifyMessageParams): Promise<GmailMessage> {
    return this.withScope(GMAIL_SCOPES.modify, async () => {
      const body = JSON.stringify({
        addLabelIds: params.addLabelIds ?? [],
        removeLabelIds: params.removeLabelIds ?? [],
      });
      return gsuiteFetch<GmailMessage>(
        this,
        `${BASE}/users/me/messages/${encodeURIComponent(params.id)}/modify`,
        { method: "POST", body },
      );
    });
  }

  // ---- 1.8.6 trashMessage / untrashMessage ------------------------------
  async trashMessage(id: string): Promise<GmailMessage> {
    return this.withScope(GMAIL_SCOPES.modify, async () =>
      gsuiteFetch<GmailMessage>(this, `${BASE}/users/me/messages/${encodeURIComponent(id)}/trash`, {
        method: "POST",
      }),
    );
  }

  async untrashMessage(id: string): Promise<GmailMessage> {
    return this.withScope(GMAIL_SCOPES.modify, async () =>
      gsuiteFetch<GmailMessage>(this, `${BASE}/users/me/messages/${encodeURIComponent(id)}/untrash`, {
        method: "POST",
      }),
    );
  }

  // ---- 1.8.7 searchMessages ---------------------------------------------
  /**
   * Search Gmail with Google's query syntax. Examples:
   *   `from:alex@example.com`, `has:attachment newer_than:7d`, `subject:"quarterly review"`.
   */
  async searchMessages(params: SearchMessagesParams): Promise<ListMessagesResult> {
    return this.listMessages({
      query: params.query,
      maxResults: params.maxResults,
      pageToken: params.pageToken,
    });
  }

  // ---- 1.8.8 listLabels / getLabel --------------------------------------
  async listLabels(): Promise<ListLabelsResult> {
    return this.withScope(GMAIL_SCOPES.readonly, async () =>
      gsuiteFetch<ListLabelsResult>(this, `${BASE}/users/me/labels`),
    );
  }

  async getLabel(id: string): Promise<GmailLabel> {
    return this.withScope(GMAIL_SCOPES.readonly, async () =>
      gsuiteFetch<GmailLabel>(this, `${BASE}/users/me/labels/${encodeURIComponent(id)}`),
    );
  }

  // ---- 1.8.9 getProfile -------------------------------------------------
  async getProfile(): Promise<GmailProfile> {
    return this.withScope(GMAIL_SCOPES.readonly, async () =>
      gsuiteFetch<GmailProfile>(this, `${BASE}/users/me/profile`),
    );
  }

  // ---- pollOnce (manual trigger, Phase 1 stand-in for scheduler) --------
  /**
   * Fetch new messages since `since` (defaults to last 24h) and turn each into
   * an `IntegrationEvent`. The caller (`/api/integrations/gsuite/services/gmail/poll`)
   * feeds each event to the notifications module.
   */
  async pollOnce(params: PollOnceParams = {}): Promise<PollOnceResult> {
    return this.withScope(GMAIL_SCOPES.readonly, async () => {
      const since = params.since ?? Date.now() - 24 * 60 * 60 * 1000;
      const sinceSeconds = Math.floor(since / 1000);
      const q = `in:inbox after:${sinceSeconds}`;
      const listing = await this.listMessages({
        query: q,
        maxResults: params.maxResults ?? 25,
      });
      const events: IntegrationEvent[] = [];
      for (const ref of listing.messages) {
        // Only pull metadata for the fields we want to record; keeps the
        // payload small and avoids over-fetching bodies during polling.
        try {
          const msg = await this.getMessage({
            id: ref.id,
            format: "metadata",
            metadataHeaders: ["From", "Subject", "Date"],
          });
          events.push({
            type: "new_email",
            service: "gsuite/gmail",
            timestamp: msg.internalDate ? Number(msg.internalDate) : Date.now(),
            data: {
              id: msg.id,
              threadId: msg.threadId,
              from: headerValue(msg, "From"),
              subject: headerValue(msg, "Subject"),
              date: headerValue(msg, "Date"),
              snippet: msg.snippet,
              labelIds: msg.labelIds,
            },
          });
        } catch {
          // Skip messages that vanish between list and get (rare).
        }
      }
      return { newMessages: events.length, events };
    });
  }
}

// --- Method metadata -----------------------------------------------------

// Re-export the framework-free descriptor types so imports of gmail.ts still work.
export type { GmailMethodName } from "./gmail-methods";

// Map of method name → invoke closure. The full `GMAIL_METHODS` array (below)
// is built by combining these with `GMAIL_METHOD_DESCRIPTORS`, so we can't
// forget a method without a type error.
const GMAIL_INVOKERS: Record<
  GmailMethodName,
  (adapter: GmailAdapter, args: Record<string, unknown>) => Promise<unknown>
> = {
  listMessages: (adapter, args) =>
    adapter.listMessages({
      query: args.query as string | undefined,
      labelIds: args.labelIds as string[] | undefined,
      maxResults: args.maxResults as number | undefined,
      pageToken: args.pageToken as string | undefined,
      includeSpamTrash: args.includeSpamTrash as boolean | undefined,
    }),
  getMessage: (adapter, args) =>
    adapter.getMessage({
      id: String(args.id),
      format: args.format as MessageFormat | undefined,
      metadataHeaders: args.metadataHeaders as string[] | undefined,
    }),
  sendMessage: (adapter, args) =>
    adapter.sendMessage({
      to: String(args.to),
      subject: String(args.subject),
      body: String(args.body),
      cc: args.cc as string | undefined,
      bcc: args.bcc as string | undefined,
      replyTo: args.replyTo as string | undefined,
      mimeType: args.mimeType as SendMessageParams["mimeType"],
    }),
  replyToMessage: (adapter, args) =>
    adapter.replyToMessage({
      messageId: String(args.messageId),
      body: String(args.body),
      mimeType: args.mimeType as ReplyToMessageParams["mimeType"],
    }),
  modifyMessage: (adapter, args) =>
    adapter.modifyMessage({
      id: String(args.id),
      addLabelIds: args.addLabelIds as string[] | undefined,
      removeLabelIds: args.removeLabelIds as string[] | undefined,
    }),
  trashMessage: (adapter, args) => adapter.trashMessage(String(args.id)),
  untrashMessage: (adapter, args) => adapter.untrashMessage(String(args.id)),
  searchMessages: (adapter, args) =>
    adapter.searchMessages({
      query: String(args.query),
      maxResults: args.maxResults as number | undefined,
      pageToken: args.pageToken as string | undefined,
    }),
  listLabels: (adapter) => adapter.listLabels(),
  getLabel: (adapter, args) => adapter.getLabel(String(args.id)),
  getProfile: (adapter) => adapter.getProfile(),
};

/**
 * Server-side method registry: descriptor fields + invoke closure. The
 * invoke route (actions/adapter-registry.ts) looks methods up here; the
 * CLIENT dispatcher walks GMAIL_METHOD_DESCRIPTORS instead (no server-only
 * imports).
 */
export const GMAIL_METHODS: readonly AdapterMethodMeta<GmailAdapter>[] =
  GMAIL_METHOD_DESCRIPTORS.map((d) => ({
    method: d.method,
    scope: d.scope,
    description: d.description,
    parameters: d.parameters,
    invoke: GMAIL_INVOKERS[d.method],
  }));
