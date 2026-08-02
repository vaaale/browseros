// Framework-free (no Node/fs/server-only) turn-safe chunking for a chat
// transcript. Extracted from src/lib/agent/memory/fast-loop.ts so the memory
// loops and any other reviewer (e.g. conversation-review tools) share ONE
// implementation of "never split a tool_call from its tool_result" rather
// than drifting into two independently-maintained copies of the same scan.

export interface AnyMessage {
  id?: string;
  role?: string;
  content?: unknown;
  toolCalls?: unknown[];
  toolCallId?: string;
  createdAt?: number | string;
  timestamp?: number | string;
  feedback?: { rating?: string; at?: number };
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** Render a message slice as plain text for an LLM prompt — full tool-call
 *  args and results, no truncation (callers budget via paginateConversation). */
export function renderMessages(messages: AnyMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const role = String(m?.role ?? "unknown");
    let content: string;
    if (typeof m?.content === "string") content = m.content;
    else if (m?.content == null) content = "";
    else content = safeStringify(m.content);
    lines.push(`### ${role}\n${content.trim()}`);
    if (Array.isArray(m?.toolCalls) && m.toolCalls.length > 0) {
      lines.push(`_tool calls_: ${safeStringify(m.toolCalls)}`);
    }
  }
  return lines.join("\n\n");
}

/** Group a message slice into turns: each turn starts at a user message and
 *  runs through the assistant/tool messages that follow, up to (not
 *  including) the next user message. A slice that doesn't start with a user
 *  message (e.g. resuming mid-turn after a previous chunk) still gets its
 *  leading messages as their own turn. */
export function segmentIntoTurns(messages: AnyMessage[]): AnyMessage[][] {
  const turns: AnyMessage[][] = [];
  let current: AnyMessage[] = [];
  for (const m of messages) {
    if (m?.role === "user" && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(m);
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

/** Pack turns into chunks whose rendered size stays within charBudget. A
 *  single turn that exceeds the budget on its own is kept as its own
 *  (oversized) chunk and still attempted rather than silently dropped. */
export function chunkTurns(turns: AnyMessage[][], charBudget: number): AnyMessage[][] {
  const chunks: AnyMessage[][] = [];
  let current: AnyMessage[] = [];
  let currentChars = 0;
  for (const turn of turns) {
    const turnChars = renderMessages(turn).length;
    if (current.length > 0 && currentChars + turnChars > charBudget) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(...turn);
    currentChars += turnChars;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export interface PaginateOptions {
  /** Max turns per page before starting a new one (default 15). */
  maxTurnsPerPage?: number;
  /** Max rendered chars per page before starting a new one (default 12000). */
  maxCharsPerPage?: number;
}

/** Group a whole conversation into FIXED, numbered pages — each page is an
 *  array of turns (never a partial turn), bounded by whichever of
 *  maxTurnsPerPage/maxCharsPerPage is hit first. Page-based (rather than
 *  free-form turn ranges) so a caller verifying "did the reviewer cover every
 *  page" only has to check a contiguous integer range, not reconstruct
 *  arbitrary boundaries — see src/lib/assistant/tools/server/conversation-review.ts. */
export function paginateConversation(messages: AnyMessage[], opts: PaginateOptions = {}): AnyMessage[][][] {
  const maxTurns = opts.maxTurnsPerPage ?? 15;
  const maxChars = opts.maxCharsPerPage ?? 12_000;
  const turns = segmentIntoTurns(messages);
  const pages: AnyMessage[][][] = [];
  let current: AnyMessage[][] = [];
  let currentChars = 0;
  for (const turn of turns) {
    const turnChars = renderMessages(turn).length;
    const wouldOverflow = current.length > 0 && (current.length >= maxTurns || currentChars + turnChars > maxChars);
    if (wouldOverflow) {
      pages.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(turn);
    currentChars += turnChars;
  }
  if (current.length > 0) pages.push(current);
  return pages;
}
