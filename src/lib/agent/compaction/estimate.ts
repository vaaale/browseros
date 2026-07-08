import "server-only";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";

// Pure token estimator for the compaction middleware (spec 022 FR-001).
// The heuristic is deliberately isolated behind these two functions so a real
// tokenizer (tiktoken, @anthropic-ai/tokenizer, etc.) can be dropped in later
// without changing any caller signature.

// Anthropic + OpenAI docs both put English tokens near ~4 characters each; the
// same rule of thumb holds for JSON-serialized tool payloads (which dominate a
// tool-heavy transcript).
const CHARS_PER_TOKEN = 4;

// Reserved output headroom applied when the provider does not expose an
// explicit maxOutputTokens — matches DEFAULT_MAX_TOKENS in provider.ts, which
// is the ceiling `complete()` uses for Anthropic when no cap is configured.
const DEFAULT_MAX_TOKENS = 65535;

export type CompactionPrompt = LanguageModelV3Prompt;

function textLength(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "string") return v.length;
  try {
    return JSON.stringify(v).length;
  } catch {
    return String(v).length;
  }
}

/** Char-count of a single V3 message. Roles, text parts, tool-call arguments
 *  and tool-result outputs all count — attachments and reasoning parts are
 *  serialized as JSON so their weight lands somewhere sensible. */
function messageChars(msg: CompactionPrompt[number]): number {
  let total = msg.role.length;
  if (msg.role === "system") {
    total += textLength(msg.content);
    return total;
  }
  for (const part of msg.content) {
    switch (part.type) {
      case "text":
      case "reasoning":
        total += textLength(part.text);
        break;
      case "tool-call":
        total += part.toolName.length + textLength(part.input);
        break;
      case "tool-result":
        total += part.toolName.length + textLength(part.output);
        break;
      case "file":
        // Files are usually references (URL / small base64 header) — approximate
        // by their JSON footprint rather than the decoded byte size.
        total += textLength(part);
        break;
      default:
        total += textLength(part);
    }
  }
  return total;
}

/** Estimate the number of tokens in a serialized message array. Returns a
 *  non-negative integer. Pure — no I/O, no side effects. */
export function estimateTokens(messages: CompactionPrompt): number {
  let chars = 0;
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
