import { normalizeErrorMessage } from "./signature";
import type { AgentRunEndedReason } from "@/lib/agent/subagents/types";

// Deterministic stuck-run detection (031-self-healing scope-add, FR-033,
// design ADR-13).
//
// The motivating incident: a self-heal run called `file_search` with the same
// arguments five times in a row, learned nothing new, and burned its entire
// step budget with nobody watching. Both halves of that are FACTS, not
// judgments, so this module is pure code with NO model call:
//
//   (a) the same `(tool, normalizedInput)` issued `repeatCalls` times with no
//       intervening distinct call and no intervening progress, or
//   (b) the run ended because it hit the agent's max-steps limit
//       (`endedReason === "max_steps"` — FR-033(b)).
//
// One instance per observed run, fed from the run's `onEvent` stream by the
// self-heal spine (ADR-12). It records and reports; it never remediates and
// never triggers anything — the only remedy is the user's Stop/Start (FR-034),
// and FR-035/FR-025 (a stuck run must not open a new case) is preserved by
// construction because nothing here calls the intake.
//
// Framework-free and I/O-free (no `server-only`): the case store, the events and
// the config live in the caller.

/** FR-033's default: five identical calls in a row. Low enough to catch the
 *  incident quickly, high enough that a legitimate short retry loop (a tool
 *  that genuinely warrants two or three attempts) does not trip it. */
export const DEFAULT_REPEAT_CALLS = 5;

/** Below 2, "repeated" is meaningless — a single call would be a loop. */
const MIN_REPEAT_CALLS = 2;

export interface StuckVerdict {
  stuck: boolean;
  reason?: "repeat-calls" | "max-steps";
  /** `tool({normalized input})` — what to show the user, verbatim. */
  repeatedCall?: string;
  tool?: string;
  normalizedInput?: string;
  count?: number;
}

const NOT_STUCK: StuckVerdict = { stuck: false };

/**
 * Collapse a tool input to a stable identity, reusing FR-019's normalization
 * (`normalizeErrorMessage`: lowercase, and strip UUIDs, hex ids, ISO/epoch
 * timestamps, quoted strings, numerics and the user-specific path prefix).
 *
 * It is applied per VALUE rather than to the whole JSON string on purpose. The
 * FR-019 rules replace any quoted string with a placeholder, so normalizing
 * `{"path":"a.ts"}` as one string would collapse every object with one string
 * field to the same key — and five reads of five DIFFERENT files (the most
 * ordinary thing a working agent does) would look like a loop. Per-value, the
 * quote-stripping rule still applies to quotes INSIDE a value, while `path=a.ts`
 * and `path=b.ts` stay distinct.
 */
export function normalizeToolInput(input: unknown): string {
  if (input === undefined || input === null) return "";
  if (typeof input !== "object") return normalizeErrorMessage(String(input));
  const entries: string[] = [];
  flattenInto(input, "", entries, 0, new WeakSet());
  // Sorted: an argument object's key order is the provider's business, not a
  // difference in what was called.
  return entries.sort().join("&");
}

/** How deep the per-value walk goes before falling back to serializing the
 *  whole subtree. Deep enough for any real tool schema, shallow enough that a
 *  pathological input cannot cost anything. */
const MAX_DEPTH = 4;

/** Flatten to `dotted.key=normalized-value` pairs. Nested objects are walked
 *  rather than serialized whole, for the same reason values are normalized
 *  individually: serializing `{where:{dir:"src"}}` would put the value back
 *  inside quotes, where FR-019's quoted-string rule erases it — and two calls
 *  differing only in a NESTED argument would collapse into one "repeat". */
function flattenInto(value: unknown, prefix: string, out: string[], depth: number, seen: WeakSet<object>): void {
  if (value === null || value === undefined) {
    out.push(`${prefix}=`);
    return;
  }
  if (typeof value !== "object") {
    out.push(`${prefix}=${normalizeErrorMessage(String(value))}`);
    return;
  }
  if (depth >= MAX_DEPTH || seen.has(value as object)) {
    out.push(`${prefix}=${normalizeErrorMessage(safeJson(value))}`);
    return;
  }
  seen.add(value as object);
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    out.push(`${prefix}=`);
    return;
  }
  for (const [key, child] of entries) {
    flattenInto(child, prefix ? `${prefix}.${key.toLowerCase()}` : key.toLowerCase(), out, depth + 1, seen);
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/**
 * One observed run's stuck state. Feed it `onToolCall` per tool call and
 * `onProgress` when the run produces a final text; ask `isStuck()` whenever you
 * want the current verdict, and `onRunEnd(endedReason)` once at the end.
 */
export class StuckDetector {
  private readonly threshold: number;
  private key = "";
  private tool = "";
  private normalized = "";
  private streak = 0;
  private maxSteps = false;
  private announced = false;

  constructor(opts?: { repeatCalls?: number }) {
    const raw = opts?.repeatCalls;
    this.threshold = Math.max(MIN_REPEAT_CALLS, Number.isFinite(raw) ? Math.round(raw as number) : DEFAULT_REPEAT_CALLS);
  }

  /** True once the consumer has recorded/announced this run's stuckness, so a
   *  detector that keeps seeing the repeated call does not re-announce it. */
  get fired(): boolean {
    return this.announced;
  }

  markFired(): void {
    this.announced = true;
  }

  onToolCall(tool: string, input: unknown): void {
    const normalized = normalizeToolInput(input);
    const key = `${tool}\u0000${normalized}`;
    if (key === this.key) {
      this.streak += 1;
      return;
    }
    this.key = key;
    this.tool = tool;
    this.normalized = normalized;
    this.streak = 1;
  }

  /** Real progress — the run produced a final text, so whatever it was
   *  repeating was not a dead end. */
  onProgress(): void {
    this.key = "";
    this.streak = 0;
  }

  /** The run ended. `max_steps` is FR-033(b): the run exhausted its step budget,
   *  which is stuck even when no single call repeated. */
  onRunEnd(endedReason?: AgentRunEndedReason): StuckVerdict {
    if (endedReason === "max_steps") this.maxSteps = true;
    return this.isStuck();
  }

  isStuck(): StuckVerdict {
    // Repeat-calls wins over max-steps when both hold: the user wants to know
    // WHAT it was looping on, not merely that the budget ran out.
    if (this.streak >= this.threshold) {
      return {
        stuck: true,
        reason: "repeat-calls",
        tool: this.tool,
        normalizedInput: this.normalized,
        count: this.streak,
        repeatedCall: `${this.tool}(${this.normalized})`,
      };
    }
    if (this.maxSteps) return { stuck: true, reason: "max-steps" };
    return NOT_STUCK;
  }
}
