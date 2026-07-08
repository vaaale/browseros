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

interface Msg {
  id?: string;
  role?: string;
  content?: unknown;
  toolCalls?: unknown[];
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

const INTERRUPTED_NOTE =
  "_(The previous turn was interrupted before the assistant replied. Send a message to continue.)_";

export function sanitizeLoadedMessages<T = unknown>(messages: T[]): T[] {
  if (!Array.isArray(messages) || messages.length === 0) return Array.isArray(messages) ? messages : [];

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
