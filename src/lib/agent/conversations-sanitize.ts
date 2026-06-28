// Pure helper (no imports — safe to use from client, server, or tests).
//
// When a conversation is loaded from disk, it must NEVER let the chat agent
// resume an in-flight turn. A conversation can be persisted mid-run — ending in
// tool-result messages or assistant messages with unanswered tool calls (e.g. a
// task that errored and was retrying). If those are pushed back into the agent,
// CopilotKit will try to "continue" the turn — re-executing tool calls /
// resuming the run — and the assistant appears to "start working" with no user
// input (and can loop).
//
// `trimToSettledTail` drops trailing messages until the conversation ends on a
// SETTLED boundary: a user message, or a completed assistant text reply (no
// pending tool calls). Tool calls + results in the MIDDLE of a finished turn are
// kept (they precede a settled assistant reply); only an unfinished trailing
// turn is dropped. Loading the result is therefore inert — display only.

interface Msg {
  role?: string;
  content?: unknown;
  toolCalls?: unknown[];
}

function isSettledTail(m: unknown): boolean {
  if (!m || typeof m !== "object") return false;
  const x = m as Msg;
  if (x.role === "user") return true;
  if (x.role === "assistant") {
    const hasPendingCalls = Array.isArray(x.toolCalls) && x.toolCalls.length > 0;
    const hasText = typeof x.content === "string" && x.content.trim().length > 0;
    return !hasPendingCalls && hasText;
  }
  // "tool" results, and assistant messages that are pure tool calls, are never a
  // safe place to stop — they imply the turn is still in progress.
  return false;
}

export function trimToSettledTail<T = unknown>(messages: T[]): T[] {
  if (!Array.isArray(messages)) return [];
  let end = messages.length;
  while (end > 0 && !isSettledTail(messages[end - 1])) end--;
  return messages.slice(0, end);
}
