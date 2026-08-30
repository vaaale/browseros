// The persisted chat message contract (framework-free — client, server, tests).
// This is the SAME shape historical conversations already use on disk
// (/Documents/Chats/<id>.json), so v2 renders old history unchanged and the
// thumbs/fast-loop integrations keep working.

export interface ToolCallRef {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

// A multimodal attachment on a user message OR a tool-result message (a server
// tool that read/generated an image can attach it to its own result so the
// model actually sees it, not just a text description — see ToolExecuteResult
// in tools.ts). `data` is raw base64 (no data: URI prefix). `image` renders
// inline and is sent to the model as an image block; `file` (e.g.
// application/pdf) is sent as a document block where the provider supports it.
// Non-model-supported types (audio/video) are still uploaded to the VFS and
// kept for reference but are not sent to the model.
export interface Attachment {
  type: "image" | "file";
  mimeType: string;
  /** Raw base64 (no `data:<mime>;base64,` prefix). */
  data: string;
  name?: string;
  /** VFS path where the file was persisted (best-effort), for reference. */
  vfsPath?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content?: string;
  toolCalls?: ToolCallRef[];
  /** role:"tool" only — the assistant toolCall this message answers. */
  toolCallId?: string;
  /** role:"user" — multimodal attachments sent with the message. Also valid on
   *  role:"tool" — a server tool's own result can attach an image it read or
   *  generated (see ToolExecuteResult). */
  attachments?: Attachment[];
  /** Thumbs feedback stamped by the UI; consumed by the memory fast loop. */
  feedback?: { rating: "up" | "down"; at: number };
  /** role:"assistant" only — reasoning/thinking text emitted by the model via
   *  separate reasoning_delta events (e.g. Claude extended thinking, DeepSeek R1).
   *  Stored separately from content so it never gets injected back into the model
   *  context. The UI renders it as a collapsible "Reasoning" card. */
  reasoning?: string;
  /** role:"assistant" only — set when the model turn failed; `content` holds the
   *  provider error. The UI renders it as an error card (retry / dismiss) rather
   *  than as a normal reply. */
  error?: boolean;
}

export function newMessageId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `m-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Index of the last user message, or -1. */
export function lastUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return i;
  }
  return -1;
}

/** Compact one-line summary of a tool call for the retry prompt: the tool NAME
 *  plus its arguments truncated hard. Tool *outputs* are deliberately omitted —
 *  an oversized output (e.g. a whole file read into context) is the usual cause
 *  of the failure we're retrying, so re-including it would just reproduce it. */
function retryToolLine(name: string, args: string): string {
  const trimmed = (args ?? "").trim();
  if (!trimmed || trimmed === "{}") return `- Tool call: ${name}`;
  const arg = trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
  return `- Tool call: ${name}(${arg})`;
}

/** Build the edit-resubmit content for a "retry after error": the original user
 *  question followed by a summary of what the failed turn attempted (tool-call
 *  names + short args, and any reasoning/replies) and the provider error, so the
 *  model can understand the failed approach and try a different one. The failed
 *  turn's bloated tool outputs are dropped by the edit-resubmit truncation, so
 *  this compact summary stands in for them. */
export function buildRetryPrompt(messages: ChatMessage[], errorText: string): string {
  const userIdx = lastUserIndex(messages);
  const question = (userIdx >= 0 ? messages[userIdx].content : "") ?? "";
  const lines: string[] = [];
  for (let i = userIdx + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant" || m.error) continue;
    for (const tc of m.toolCalls ?? []) lines.push(retryToolLine(tc.function.name, tc.function.arguments));
    const text = (m.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    if (text) lines.push(`- You replied: ${text}`);
  }
  const did = lines.length ? lines.join("\n") : "- (no actions were recorded)";
  return [
    question,
    "",
    "---",
    "",
    "**WOOPS**",
    `You tried answering the question above but your attempt failed with the following error: ${errorText}`,
    "This is what you did:",
    did,
    "**Error occurred**",
    "",
    "Understand why the error happened and try a different approach.",
  ].join("\n");
}

/** Truncate the history for an edit-resubmit: drop `messageId` (which must be
 *  the LAST user message) and everything after it. Throws when the id does not
 *  identify the last user message — the route surfaces this as a 409. */
export function truncateForEdit(messages: ChatMessage[], messageId: string): ChatMessage[] {
  const idx = lastUserIndex(messages);
  if (idx === -1 || messages[idx].id !== messageId) {
    throw new Error(`Message ${messageId} is not the last user message; cannot edit-resubmit.`);
  }
  return messages.slice(0, idx);
}

/** Tool ids revealed by prior find_tools results in THIS conversation (025).
 *  Derived statelessly from the transcript, mirroring tool-gate.ts, but over
 *  the persisted message shape. */
export function deriveRevealedIds(messages: ChatMessage[]): Set<string> {
  const callNames = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.toolCalls)) continue;
    for (const tc of m.toolCalls) {
      if (tc?.id && tc.function?.name) callNames.set(tc.id, tc.function.name);
    }
  }
  const revealed = new Set<string>();
  for (const m of messages) {
    if (m.role !== "tool" || !m.toolCallId) continue;
    if (callNames.get(m.toolCallId) !== "find_tools") continue;
    try {
      const payload = JSON.parse(m.content ?? "");
      if (!Array.isArray(payload)) continue;
      for (const r of payload) {
        const id = (r as { id?: unknown })?.id;
        if (typeof id === "string" && id) revealed.add(id);
      }
    } catch {
      /* malformed find_tools payload — skip */
    }
  }
  return revealed;
}
