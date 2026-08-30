import "server-only";
import type { ChatMessage } from "@/lib/assistant/messages";

// Pure token estimator, native to BOS's ChatMessage transcript shape (no more
// AI-SDK v3 prompt intermediate — see v2.ts). Isolated behind these two
// functions so a real tokenizer can be dropped in later without changing any
// caller signature.

// Anthropic + OpenAI docs both put English tokens near ~4 characters each; the
// same rule of thumb holds for JSON-serialized tool payloads (which dominate a
// tool-heavy transcript).
const CHARS_PER_TOKEN = 4;

// Reserved output headroom applied when the provider does not expose an
// explicit maxOutputTokens — matches DEFAULT_MAX_TOKENS in provider.ts, which
// is the ceiling `complete()` uses for Anthropic when no cap is configured.
const DEFAULT_MAX_TOKENS = 65535;

function textLength(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "string") return v.length;
  try {
    return JSON.stringify(v).length;
  } catch {
    return String(v).length;
  }
}

/** Char-count of a single ChatMessage: role, content, tool-call name+args,
 *  and attachments (base64 payload counted directly, not JSON-wrapped). */
function messageChars(m: ChatMessage): number {
  let total = m.role.length + textLength(m.content);
  for (const tc of m.toolCalls ?? []) total += tc.function.name.length + textLength(tc.function.arguments);
  for (const a of m.attachments ?? []) total += a.mimeType.length + a.data.length;
  return total;
}

/** Estimate the number of tokens in a system prompt + message array. Returns a
 *  non-negative integer. Pure — no I/O, no side effects. */
export function estimateChatTokens(system: string, messages: ChatMessage[]): number {
  let chars = system.length;
  for (const m of messages) chars += messageChars(m);
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export interface BudgetInput {
  /** Provider-declared context window (max input tokens). Optional. */
  maxInputTokens?: number;
  /** Max output tokens the caller is prepared to spend on this response. */
  maxTokens?: number;
  /** Fallback context window when the provider doesn't declare one. */
  assumedContextTokens: number;
}

/** Effective budget = (maxInputTokens ?? assumedContextTokens) − output headroom.
 *  Never returns a negative value. */
export function estimateBudget(input: BudgetInput): number {
  const window = input.maxInputTokens ?? input.assumedContextTokens;
  const headroom = input.maxTokens ?? DEFAULT_MAX_TOKENS;
  const budget = window - headroom;
  return budget > 0 ? budget : 0;
}
