// Deterministic failure-signature computation (031-self-healing FR-019,
// design ADR-7).
//
// The dedupe key is computed in Phase A of the spine, BEFORE the Diagnostician
// runs, using pure code only — no LLM call. That ordering is the whole point:
// a duplicate must never cost Diagnostician tokens. Pure functions, no I/O, so
// the normalization rules (the part that actually determines dedupe quality)
// are directly unit-testable.

import { createHash } from "node:crypto";
import type { ErrorCategory, FailureSignature, TriggerContext } from "./types";

/** Message-pattern → category, tried in order after HTTP status and error code.
 *  Ordered most-specific-first: `permission denied` must win over a bare
 *  `denied`, and `timed out` must not be swallowed by `not found`. */
const MESSAGE_PATTERNS: readonly [RegExp, ErrorCategory][] = [
  [/\b(permission denied|eacces|eperm|not permitted|forbidden)\b/, "permission_denied"],
  [/\b(etimedout|timed? ?out|timeout|deadline exceeded)\b/, "timeout"],
  [/\b(enoent|not found|no such file|does not exist|unknown (tool|app|agent|event))\b/, "not_found"],
  [/\b(rate ?limit|too many requests|quota exceeded)\b/, "rate_limit"],
  [/\b(unauthori[sz]ed|authentication|invalid api key|missing api key|token expired)\b/, "auth"],
  [/\b(is not a function|cannot read propert|undefined is not|expected .* (got|received)|invalid type|type ?error|failed validation|schema)\b/, "type_mismatch"],
];

/** Node/JS error codes and constructor names that map straight to a bucket. */
const CODE_CATEGORIES: Record<string, ErrorCategory> = {
  EACCES: "permission_denied",
  EPERM: "permission_denied",
  ETIMEDOUT: "timeout",
  ESOCKETTIMEDOUT: "timeout",
  TimeoutError: "timeout",
  AbortError: "timeout",
  ENOENT: "not_found",
  ENOTDIR: "not_found",
  NotFoundError: "not_found",
  TypeError: "type_mismatch",
  RangeError: "type_mismatch",
  SyntaxError: "type_mismatch",
  ValidationError: "type_mismatch",
};

/**
 * Assign the coarse bucket, in the priority order FR-019 states: HTTP status
 * first (the most reliable signal when present), then the exception
 * type/code, then the message pattern, else `unhandled_exception`.
 */
export function errorCategoryOf(input: {
  httpStatus?: number;
  errorCode?: string;
  errorMessage?: string;
}): ErrorCategory {
  const status = input.httpStatus;
  if (typeof status === "number" && status > 0) {
    if (status === 401 || status === 403) return "auth";
    if (status === 404) return "not_found";
    if (status === 408 || status === 504) return "timeout";
    if (status === 429) return "rate_limit";
    if (status === 400 || status === 422) return "type_mismatch";
    if (status >= 500) return "unhandled_exception";
  }
  const code = (input.errorCode ?? "").trim();
  if (code && CODE_CATEGORIES[code]) return CODE_CATEGORIES[code];

  const message = (input.errorMessage ?? "").toLowerCase();
  for (const [pattern, category] of MESSAGE_PATTERNS) {
    if (pattern.test(message)) return category;
  }
  return "unhandled_exception";
}

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
const LONG_HEX_RE = /\b[0-9a-f]{7,}\b/g;
const ISO_TS_RE = /\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}(:\d{2})?(\.\d+)?z?\b/g;
const EPOCH_RE = /\b\d{10,}\b/g;
const QUOTED_RE = /(["'`])(?:\\.|(?!\1)[^\\])*\1/g;
const NUMBER_RE = /\b\d+(\.\d+)?\b/g;
/** A leading, user-specific absolute-path prefix: `/home/x/…`, `/Users/x/…`,
 *  `/app/data/…`, `/worktrees/<branch>/…`, `/data-clones/<branch>/…`. */
const USER_PATH_PREFIX_RE = /(^|[\s(=:])\/(home|users|root|app|tmp|var|worktrees|data-clones|private)(\/[^\s)'",;]*)?/g;

const PLACEHOLDER = "<x>";

/**
 * Strip everything variable out of an error message so the same logical
 * failure hashes identically across runs. The rules are the design surface
 * (ADR-7) — deliberately explicit and individually testable.
 *
 * `stripPathPrefix` (default on) also collapses the leading user-specific
 * segment of absolute paths, so the same bug hit at two different paths still
 * dedupes. It's the one judgment call here: too aggressive merges distinct
 * bugs, too conservative misses the same bug twice. Flip it off to keep paths.
 */
export function normalizeErrorMessage(message: string, opts?: { stripPathPrefix?: boolean }): string {
  const stripPathPrefix = opts?.stripPathPrefix ?? true;
  let out = (message ?? "").toLowerCase();
  out = out.replace(UUID_RE, PLACEHOLDER);
  out = out.replace(ISO_TS_RE, PLACEHOLDER);
  out = out.replace(EPOCH_RE, PLACEHOLDER);
  if (stripPathPrefix) {
    out = out.replace(USER_PATH_PREFIX_RE, (_m, lead: string) => `${lead}${PLACEHOLDER}`);
  }
  out = out.replace(QUOTED_RE, PLACEHOLDER);
  out = out.replace(LONG_HEX_RE, PLACEHOLDER);
  out = out.replace(NUMBER_RE, PLACEHOLDER);
  // Collapse runs of placeholders left behind by the substitutions above, then
  // whitespace, so cosmetic differences can't split a signature.
  out = out.replace(/(<x>[\s/:.-]*){2,}/g, `${PLACEHOLDER} `);
  return out.replace(/\s+/g, " ").trim();
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/** One-line human label for the case list and the report frontmatter. Takes the
 *  ALREADY-RESOLVED tool name so the label and the dedupe key can never
 *  disagree about which tool a case is about. */
function labelFor(ctx: TriggerContext, category: ErrorCategory, toolName: string): string {
  if (ctx.trigger === "explicit") {
    return truncate(ctx.description || ctx.errorMessage || "reported problem", 120);
  }
  if (ctx.trigger === "workflow-timeout" && ctx.workflow) {
    const node = ctx.workflow.node ? ` node ${ctx.workflow.node}` : "";
    return truncate(`workflow ${ctx.workflow.id}${node} timed out`, 120);
  }
  return truncate(`${toolName}: ${category}${ctx.errorMessage ? ` — ${ctx.errorMessage}` : ""}`, 120);
}

/**
 * Compute the deterministic dedupe identity for one trigger.
 *
 * The explicit trigger deliberately gets a RELAXED key —
 * `(toolName, "explicit", description_hash)` — because a user re-firing the
 * same report is usually intentional; combined with the shorter explicit
 * window it means a deliberate re-report becomes a new case (FR-019).
 */
export function computeFailureSignature(
  ctx: TriggerContext,
  opts?: { stripPathPrefix?: boolean },
): FailureSignature {
  const toolName = (ctx.toolName || (ctx.workflow ? `workflow:${ctx.workflow.id}` : "") || ctx.component || "self_heal.request").trim();

  if (ctx.trigger === "explicit") {
    const normalized = normalizeErrorMessage(ctx.description ?? ctx.errorMessage ?? "", opts);
    const normalizedHash = sha256Hex(normalized);
    return {
      toolName,
      errorCategory: "explicit",
      normalizedHash,
      dedupeKey: `${toolName}:explicit:${normalizedHash}`,
      label: labelFor(ctx, "explicit", toolName),
    };
  }

  const errorCategory = errorCategoryOf(ctx);
  // Include the category in the hashed body as well as the key: two genuinely
  // different failures that normalize to the same words (e.g. a bare "failed")
  // must not collide just because their messages are uninformative.
  const normalized = normalizeErrorMessage(ctx.errorMessage ?? "", opts);
  const normalizedHash = sha256Hex(`${errorCategory}\n${normalized}`);
  return {
    toolName,
    errorCategory,
    normalizedHash,
    dedupeKey: `${toolName}:${errorCategory}:${normalizedHash}`,
    label: labelFor(ctx, errorCategory, toolName),
  };
}

/** The window that applies to a trigger — FR-019's explicit-vs-rest split. */
export function dedupeWindowSecFor(
  trigger: TriggerContext["trigger"],
  cfg: { dedupeWindowSec: number; explicitDedupeWindowSec: number },
): number {
  return trigger === "explicit" ? cfg.explicitDedupeWindowSec : cfg.dedupeWindowSec;
}
