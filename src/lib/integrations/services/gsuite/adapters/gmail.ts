import "server-only";
import { ServiceAdapter } from "../../../adapters/base";
import { getService } from "../../../registry";
import { IntegrationConfigError } from "../../../errors";
import type { IntegrationEvent, ServiceDefinition } from "../../../types";
import type { AdapterMethodMeta } from "../../../actions/types";
import { gsuiteFetch } from "../client";
import { GMAIL_SCOPES } from "../manifest";
import { GMAIL_METHOD_DESCRIPTORS, type GmailMethodName } from "./gmail-methods";
import { mkdir, stat, writeBuffer } from "@/os/vfs";

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
// Soft cap on `messages_download_attachment` payloads. Anything larger returns
// `{ error: "too_large" }` so the LLM can decide (skip / ask user / etc.).
const DEFAULT_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
const ATTACHMENT_DIR = "/Documents/Emails";

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

export interface DownloadAttachmentParams {
  messageId: string;
  attachmentId: string;
}
export type DownloadAttachmentResult =
  | { path: string; size: number; mimeType: string }
  | { error: "too_large"; size: number; maxBytes: number };

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

// Walk a Gmail message payload tree (root + nested parts) for the part whose
// body carries `attachmentId`. Returns undefined if none matches — the caller
// treats that as an invalid attachmentId for the given message.
function findAttachmentPart(
  payload: GmailMessagePayload | undefined,
  attachmentId: string,
): GmailMessagePayload | undefined {
  if (!payload) return undefined;
  if (payload.body?.attachmentId === attachmentId) return payload;
  for (const part of payload.parts ?? []) {
    const hit = findAttachmentPart(part, attachmentId);
    if (hit) return hit;
  }
  return undefined;
}

// Strip characters that would break the VFS path or the host FS: path
// separators, NUL, and other C0/C1 control chars. Also trims surrounding
// whitespace and dots (Windows-hostile) and falls back to a stable default
// when nothing usable is left.
function sanitizeAttachmentFilename(raw: string | undefined): string {
  const trimmed = (raw ?? "").replace(/[\/\\\x00-\x1f\x7f]/g, "_").trim().replace(/^\.+|\.+$/g, "");
  return trimmed || "attachment.bin";
}

// URL-safe base64 (RFC 4648 §5, Gmail's attachment encoding) → Buffer.
// Node's Buffer.from(..., "base64") already tolerates both alphabets, but we
// normalise explicitly so a stricter decoder would still accept the input.
function decodeBase64Url(data: string): Buffer {
  const normalised = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalised + "=".repeat((4 - (normalised.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

// Extracted view of a Gmail message payload used by getMessageAsMarkdown.
// The Gmail API returns a nested tree of parts; we flatten it into three
// buckets so the caller doesn't have to think about MIME structure.
interface ExtractedParts {
  plain: string[];
  html: string[];
  attachments: Array<{
    filename: string;
    attachmentId: string;
    mimeType?: string;
    size?: number;
  }>;
}

function extractParts(payload: GmailMessagePayload | undefined): ExtractedParts {
  const out: ExtractedParts = { plain: [], html: [], attachments: [] };
  const walk = (p: GmailMessagePayload): void => {
    const mime = (p.mimeType ?? "").toLowerCase();
    const body = p.body;
    if (body?.attachmentId) {
      out.attachments.push({
        filename: p.filename || "attachment.bin",
        attachmentId: body.attachmentId,
        mimeType: p.mimeType,
        size: body.size,
      });
    } else if (body?.data && mime.startsWith("text/plain")) {
      out.plain.push(decodeBase64Url(body.data).toString("utf8"));
    } else if (body?.data && mime.startsWith("text/html")) {
      out.html.push(decodeBase64Url(body.data).toString("utf8"));
    }
    for (const child of p.parts ?? []) walk(child);
  };
  if (payload) walk(payload);
  return out;
}

// Minimal HTML → markdown fallback used only when a message has no text/plain
// alternative. Not a full parser — just the tag set that shows up in ~99% of
// mail: block wrappers (p, div, br, headings), lists, inline emphasis, and
// links. Anything else is stripped. Ambient <style>/<script>/<head> are
// dropped first so their contents don't leak into the output.
function htmlToMarkdown(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n\n")
    .replace(/<p[^>]*>/gi, "")
    .replace(/<\/div\s*>/gi, "\n")
    .replace(/<div[^>]*>/gi, "")
    .replace(/<h([1-6])[^>]*>/gi, (_m, n: string) => `\n${"#".repeat(Number(n))} `)
    .replace(/<\/h[1-6]\s*>/gi, "\n")
    .replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)\s*>/gi, "**$1**")
    .replace(/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)\s*>/gi, "*$1*")
    .replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, "[$2]($1)")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/li\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Escape a cell value for a markdown table (pipes are the only meaningful
// separator; newlines would break the row).
function escapeTableCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

async function vfsExists(vfsPath: string): Promise<boolean> {
  try {
    await stat(vfsPath);
    return true;
  } catch {
    return false;
  }
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

  // ---- 1.8.2b getMessageAsMarkdown --------------------------------------
  /**
   * LLM-facing variant of `getMessage`: fetches with `format=full`, walks the
   * MIME tree, and returns a markdown document containing headers, the body
   * (text/plain preferred, text/html downgraded via `htmlToMarkdown`), and —
   * if the message has attachments — a `| filename | id |` table the model
   * can feed straight into `gmail_messages_download_attachment`.
   */
  async getMessageAsMarkdown(params: { id: string }): Promise<string> {
    const msg = await this.getMessage({ id: params.id, format: "full" });
    const subject = headerValue(msg, "Subject") ?? "(no subject)";
    const from = headerValue(msg, "From") ?? "";
    const to = headerValue(msg, "To") ?? "";
    const cc = headerValue(msg, "Cc");
    const bcc = headerValue(msg, "Bcc");
    const date = headerValue(msg, "Date") ?? "";
    const { plain, html, attachments } = extractParts(msg.payload);

    let body: string;
    if (plain.length > 0) {
      body = plain.join("\n\n").trim();
    } else if (html.length > 0) {
      body = htmlToMarkdown(html.join("\n"));
    } else if (msg.snippet) {
      body = msg.snippet;
    } else {
      body = "_(empty body)_";
    }

    const lines: string[] = [];
    lines.push(`# ${subject}`);
    lines.push("");
    lines.push(`- **From:** ${from}`);
    lines.push(`- **To:** ${to}`);
    if (cc) lines.push(`- **Cc:** ${cc}`);
    if (bcc) lines.push(`- **Bcc:** ${bcc}`);
    if (date) lines.push(`- **Date:** ${date}`);
    lines.push(`- **Message id:** \`${msg.id}\``);
    lines.push(`- **Thread id:** \`${msg.threadId}\``);
    if (msg.labelIds?.length) lines.push(`- **Labels:** ${msg.labelIds.join(", ")}`);
    lines.push("");
    lines.push("## Body");
    lines.push("");
    lines.push(body);
    lines.push("");
    if (attachments.length > 0) {
      lines.push(`## Attachments (${attachments.length})`);
      lines.push("");
      lines.push("| filename | id |");
      lines.push("| --- | --- |");
      for (const a of attachments) {
        lines.push(`| ${escapeTableCell(a.filename)} | ${escapeTableCell(a.attachmentId)} |`);
      }
      lines.push("");
      lines.push(
        `_Use \`gmail_messages_download_attachment\` with messageId=\`${msg.id}\` and one of the ids above to save an attachment to the VFS._`,
      );
    }
    return lines.join("\n");
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

  // ---- 1.8.7b downloadAttachment ----------------------------------------
  /**
   * Download a Gmail attachment and persist it to the BOS VFS under
   * `/Documents/Emails`. Filename + mime type come from the parent message's
   * part (Gmail's attachment endpoint itself only returns `{ data, size }`),
   * so we fetch the message metadata first, then the attachment body.
   *
   * Collision rule: if the target file already exists, we append `-<msgId8>`
   * to the stem (never overwrite). If that name is also taken (same msg re-
   * downloaded) we let the overwrite happen — the two files are byte-equal.
   */
  async downloadAttachment(params: DownloadAttachmentParams): Promise<DownloadAttachmentResult> {
    return this.withScope(GMAIL_SCOPES.readonly, async () => {
      const maxBytes = DEFAULT_ATTACHMENT_MAX_BYTES;
      // Fetch the parent message so we can resolve filename + mimeType for the
      // attachment part. `format=full` is required — metadata mode omits parts.
      const message = await this.getMessage({ id: params.messageId, format: "full" });
      const part = findAttachmentPart(message.payload, params.attachmentId);
      if (!part) {
        throw new Error(
          `Attachment ${params.attachmentId} not found on message ${params.messageId}`,
        );
      }
      const filename = sanitizeAttachmentFilename(part.filename);
      const mimeType = part.mimeType ?? "application/octet-stream";
      const declaredSize = part.body?.size;
      if (typeof declaredSize === "number" && declaredSize > maxBytes) {
        return { error: "too_large" as const, size: declaredSize, maxBytes };
      }
      // Fetch the attachment body (URL-safe base64).
      const attachmentUrl =
        `${BASE}/users/me/messages/${encodeURIComponent(params.messageId)}` +
        `/attachments/${encodeURIComponent(params.attachmentId)}`;
      const res = await gsuiteFetch<{ size?: number; data?: string }>(this, attachmentUrl);
      if (!res.data) {
        throw new Error(
          `Gmail returned no data for attachment ${params.attachmentId} on message ${params.messageId}`,
        );
      }
      const buffer = decodeBase64Url(res.data);
      if (buffer.byteLength > maxBytes) {
        return { error: "too_large" as const, size: buffer.byteLength, maxBytes };
      }
      // Ensure the target directory exists (VFS `mkdir` is recursive).
      await mkdir(ATTACHMENT_DIR);
      // Collision handling: if `filename` is taken, append a short message-id
      // suffix before the extension.
      const dotIdx = filename.lastIndexOf(".");
      const stem = dotIdx > 0 ? filename.slice(0, dotIdx) : filename;
      const ext = dotIdx > 0 ? filename.slice(dotIdx) : "";
      let targetName = filename;
      let targetPath = `${ATTACHMENT_DIR}/${targetName}`;
      if (await vfsExists(targetPath)) {
        const suffix = params.messageId.slice(0, 8);
        targetName = `${stem}-${suffix}${ext}`;
        targetPath = `${ATTACHMENT_DIR}/${targetName}`;
      }
      await writeBuffer(targetPath, buffer);
      return { path: targetPath, size: buffer.byteLength, mimeType };
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
  messages_list: (adapter, args) =>
    adapter.listMessages({
      query: args.query as string | undefined,
      labelIds: args.labelIds as string[] | undefined,
      maxResults: args.maxResults as number | undefined,
      pageToken: args.pageToken as string | undefined,
      includeSpamTrash: args.includeSpamTrash as boolean | undefined,
    }),
  messages_get: (adapter, args) =>
    adapter.getMessageAsMarkdown({ id: String(args.id) }),
  messages_send: (adapter, args) =>
    adapter.sendMessage({
      to: String(args.to),
      subject: String(args.subject),
      body: String(args.body),
      cc: args.cc as string | undefined,
      bcc: args.bcc as string | undefined,
      replyTo: args.replyTo as string | undefined,
      mimeType: args.mimeType as SendMessageParams["mimeType"],
    }),
  messages_reply: (adapter, args) =>
    adapter.replyToMessage({
      messageId: String(args.messageId),
      body: String(args.body),
      mimeType: args.mimeType as ReplyToMessageParams["mimeType"],
    }),
  messages_modify: (adapter, args) =>
    adapter.modifyMessage({
      id: String(args.id),
      addLabelIds: args.addLabelIds as string[] | undefined,
      removeLabelIds: args.removeLabelIds as string[] | undefined,
    }),
  messages_trash: (adapter, args) => adapter.trashMessage(String(args.id)),
  messages_untrash: (adapter, args) => adapter.untrashMessage(String(args.id)),
  messages_search: (adapter, args) =>
    adapter.searchMessages({
      query: String(args.query),
      maxResults: args.maxResults as number | undefined,
      pageToken: args.pageToken as string | undefined,
    }),
  messages_download_attachment: (adapter, args) =>
    adapter.downloadAttachment({
      messageId: String(args.messageId),
      attachmentId: String(args.attachmentId),
    }),
  labels_list: (adapter) => adapter.listLabels(),
  labels_get: (adapter, args) => adapter.getLabel(String(args.id)),
  profile_get: (adapter) => adapter.getProfile(),
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

// --- Registration --------------------------------------------------------
// Register this adapter with the server-side registry at module load. The
// `adapter-registry.ts` module side-effect-imports this file so any server
// entry that touches the registry sees Gmail registered. Guarded to be
// re-import safe (adapter-registry throws on duplicate ids).
import { registerAdapter, getAdapterEntry as _getAdapterEntry } from "../../../actions/adapter-registry";
if (!_getAdapterEntry("gsuite", "gmail")) {
  registerAdapter("gsuite", "gmail", {
    createAdapter: () => new GmailAdapter(),
    methods: GMAIL_METHODS,
    capabilities: { poll: true, webhook: true },
  });
}
