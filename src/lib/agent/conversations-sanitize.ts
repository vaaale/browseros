// Pure helper (no imports — safe to use from client, server, or tests).
//
// A conversation can be persisted MID-RUN — ending in a tool result, or an
// assistant message with pending (unanswered) tool calls. If that tail is fed
// back to CopilotKit on load, it "continues" the turn — re-executing tool calls
// or generating a reply — so the assistant appears to start working with no user
// input (and can loop). See e2e/no-uncommanded-run.spec.ts.
//
// We must NOT throw history away to achieve that, though: many models (e.g. qwen)
// emit preamble text AND a tool call in the SAME assistant message, so a
// tool-heavy conversation stopped mid-run has NO "assistant text with no tool
// calls" boundary to stop at — trimming to the last such boundary silently
// truncates the whole conversation back to the first user message (data loss).
//
// `sanitizeLoadedMessages` keeps the full history and makes the tail INERT:
//   1. drop only a trailing assistant message whose tool calls are UNANSWERED
//      (those are the ones that would re-execute), then
//   2. if the conversation now ends on a tool result, append a settled assistant
//      note so CopilotKit sees a completed turn with nothing to continue.
// The result displays the full history and never resumes a run.
//
// `normalizeMessages` is applied on both load and save to repair messages that
// were corrupted by providers that stream full accumulated content on each chunk
// instead of incremental deltas — which causes duplicate <think> blocks and
// duplicate tool-call entries with the same id.

interface Msg {
  id?: string;
  role?: string;
  content?: unknown;
  toolCalls?: unknown[];
}

interface ToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

// Deduplicate tool calls with the same id, keeping the entry with the longest
// (most complete) arguments. Preserves original order of first occurrences.
function deduplicateToolCalls(toolCalls: unknown[]): unknown[] {
  if (!Array.isArray(toolCalls) || toolCalls.length <= 1) return toolCalls;
  const best = new Map<string, ToolCall>();
  for (const tc of toolCalls) {
    if (!tc || typeof tc !== "object") continue;
    const c = tc as ToolCall;
    if (!c.id) continue;
    const existing = best.get(c.id);
    const newLen = c.function?.arguments?.length ?? 0;
    const existLen = existing?.function?.arguments?.length ?? 0;
    if (!existing || newLen > existLen) best.set(c.id, c);
  }
  const seen = new Set<string>();
  const result: unknown[] = [];
  for (const tc of toolCalls) {
    if (!tc || typeof tc !== "object") { result.push(tc); continue; }
    const c = tc as ToolCall;
    if (!c.id) { result.push(tc); continue; }
    if (!seen.has(c.id)) {
      result.push(best.get(c.id) ?? tc);
      seen.add(c.id);
    }
  }
  return result;
}

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

// Strip duplicate <think>…</think> blocks from content, keeping only the first.
// Persisted messages can accumulate duplicates when the provider streams full
// accumulated content on each chunk rather than sending incremental deltas.
function normalizeContent(content: string): string {
  const firstOpen = content.indexOf(THINK_OPEN);
  if (firstOpen === -1) return content;
  const afterOpen = firstOpen + THINK_OPEN.length;
  const firstClose = content.indexOf(THINK_CLOSE, afterOpen);
  if (firstClose === -1) return content; // streaming artifact — leave as-is
  const afterFirstBlock = content.slice(firstClose + THINK_CLOSE.length);
  if (!afterFirstBlock.includes(THINK_OPEN)) return content; // no duplicates
  const cleanedAnswer = afterFirstBlock
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/^\s+/, "");
  return content.slice(0, firstClose + THINK_CLOSE.length) + (cleanedAnswer ? "\n" + cleanedAnswer : "");
}

function normalizeMsg(msg: unknown): unknown {
  if (!msg || typeof msg !== "object") return msg;
  const m = msg as Msg;
  if (m.role !== "assistant") return msg;
  let changed = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const next: Record<string, any> = { ...m };
  if (typeof m.content === "string" && m.content.includes(THINK_OPEN)) {
    const cleaned = normalizeContent(m.content);
    if (cleaned !== m.content) { next.content = cleaned; changed = true; }
  }
  if (Array.isArray(m.toolCalls) && m.toolCalls.length > 1) {
    const deduped = deduplicateToolCalls(m.toolCalls);
    if (deduped.length !== m.toolCalls.length) { next.toolCalls = deduped; changed = true; }
  }
  return changed ? next : msg;
}

/** Repair messages corrupted by non-incremental streaming. Safe to call on
 *  clean messages — returns the same array reference when nothing changes. */
export function normalizeMessages<T = unknown>(messages: T[]): T[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  let dirty = false;
  const result = messages.map((m) => {
    const n = normalizeMsg(m) as T;
    if (n !== m) dirty = true;
    return n;
  });
  return dirty ? result : messages;
}

function hasPendingCalls(m: Msg): boolean {
  return Array.isArray(m.toolCalls) && m.toolCalls.length > 0;
}

// A safe stopping point on its own: a user message, or an assistant message with
// no pending tool calls. A tool result is NOT safe by itself (the turn has no
// closing assistant reply yet) — it gets a synthetic one appended instead.
function isSettled(m: unknown): boolean {
  if (!m || typeof m !== "object") return false;
  const x = m as Msg;
  if (x.role === "user") return true;
  if (x.role === "assistant") return !hasPendingCalls(x);
  return false;
}

/** A snapshot is stale when it is a strict prefix-regression of what is already
 *  persisted: fewer messages AND every incoming id already present. That is a
 *  late/debounced writer losing the race — writing it would delete the newest
 *  turns. A legitimately shortened history (regenerate, edit) replaces the tail
 *  with NEW message ids, so it does not match and still writes. Messages
 *  without ids make the comparison unsafe → never report stale. */
export function isStaleSnapshot(incoming: unknown[], existing: unknown[]): boolean {
  if (incoming.length === 0 || incoming.length >= existing.length) return false;
  const existingIds = new Set<string>();
  for (const m of existing) {
    const mid = m && typeof m === "object" ? (m as Msg).id : undefined;
    if (typeof mid === "string") existingIds.add(mid);
  }
  for (const m of incoming) {
    const mid = m && typeof m === "object" ? (m as Msg).id : undefined;
    if (typeof mid !== "string" || !existingIds.has(mid)) return false;
  }
  return true;
}

const INTERRUPTED_NOTE =
  "_(The previous turn was interrupted before the assistant replied. Send a message to continue.)_";

export function sanitizeLoadedMessages<T = unknown>(messages: T[]): T[] {
  if (!Array.isArray(messages) || messages.length === 0) return Array.isArray(messages) ? messages : [];
  messages = normalizeMessages(messages);

  // 1. Drop a trailing assistant turn whose tool calls were never answered — those
  //    are what CopilotKit would re-execute. (A tool result following the call is
  //    itself the last message, so this only strips a truly-dangling final call.)
  let end = messages.length;
  while (end > 0) {
    const m = messages[end - 1] as Msg;
    if (m && typeof m === "object" && m.role === "assistant" && hasPendingCalls(m)) end--;
    else break;
  }
  const kept = messages.slice(0, end);
  if (kept.length === 0) return kept;

  // 2. If it ends on a tool result, close the turn with a settled assistant note
  //    so nothing resumes; otherwise the tail is already settled.
  const last = kept[kept.length - 1];
  if (isSettled(last)) return kept;
  const note = { id: `interrupted-${(last as Msg)?.id ?? end}`, role: "assistant", content: INTERRUPTED_NOTE } as unknown as T;
  return [...kept, note];
}
