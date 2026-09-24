// The environmental-error allowlist (031-self-healing FR-002, clarification C2)
// and the BOS-owned logging-component allowlist (FR-005, design R8).
//
// Both are static, code-defined v1 lists — not user-configurable. They are the
// mechanism's outer filter: an error that matches the environmental allowlist
// never reaches the Diagnostician at all, so getting them wrong is either wasted
// LLM spend (too loose) or a missed bug (too tight).
//
// `permission_denied` is deliberately NOT environmental (C2). It always
// triggers; the Diagnostician then decides whether it's the user's disk
// permissions (class a) or BOS dropping a permission (class e). That decision
// needs investigation, which is exactly what the Diagnostician is for.

import type { TriggerContext } from "./types";

/** Errors that are UNCONDITIONALLY external to BOS. Anything conditional (a
 *  permission error, a 404, a type mismatch) belongs to the Diagnostician. */
const ENV_MESSAGE_PATTERNS: readonly RegExp[] = [
  // Network / socket
  /\b(econnrefused|econnreset|econnaborted|ehostunreach|enetunreach|enetdown|epipe|socket hang up|network error|network is unreachable|tls handshake|certificate has expired|self[- ]signed certificate)\b/,
  // DNS
  /\b(enotfound|eai_again|dns lookup failed|getaddrinfo)\b/,
  // Auth against an EXTERNAL service (401) and rate limits (429)
  /\b(401 unauthori[sz]ed|http 401|status 401|invalid api key|missing api key|api key not configured)\b/,
  /\b(429|rate ?limit(ed|ing)?|too many requests|quota exceeded|overloaded_error)\b/,
  // OOM / kills
  /\b(enomem|out of memory|heap out of memory|sigkill|killed: 9|oom[- ]killed)\b/,
  // External service timeouts (an upstream/gateway, not BOS's own tool budget)
  /\b(504 gateway|gateway timeout|upstream (request )?timed? ?out|etimedout connecting|request to https?:\/\/\S+ timed out)\b/,
];

/** Node error codes that are unconditionally environmental. */
const ENV_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENOMEM",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
]);

/** HTTP statuses that are unconditionally environmental: an external service
 *  refusing us (401) or throttling us (429), or a gateway timing out (504). */
const ENV_HTTP_STATUSES = new Set([401, 429, 502, 503, 504]);

/**
 * True when this failure is unconditionally external and the mechanism MUST
 * NOT fire (FR-002 / SC-003: zero cases, zero tokens).
 *
 * The explicit trigger is never suppressed by this filter — a human (or an
 * agent) deliberately reporting a problem always gets a case, even if the
 * symptom they describe mentions a timeout.
 */
export function isEnvironmentalError(input: {
  trigger?: TriggerContext["trigger"];
  errorMessage?: string;
  errorCode?: string;
  httpStatus?: number;
}): boolean {
  if (input.trigger === "explicit") return false;
  if (typeof input.httpStatus === "number" && ENV_HTTP_STATUSES.has(input.httpStatus)) return true;
  const code = (input.errorCode ?? "").trim().toUpperCase();
  if (code && ENV_CODES.has(code)) return true;
  const message = (input.errorMessage ?? "").toLowerCase();
  if (!message) return false;
  return ENV_MESSAGE_PATTERNS.some((re) => re.test(message));
}

/**
 * The logging component namespaces BOS owns (FR-005, design R8).
 *
 * An ALLOWLIST, not a blocklist: an unknown or third-party component is
 * excluded by default. That is the safer default for a mechanism that can
 * drive code changes — a noisy MCP server or integration must not be able to
 * conscript the self-healer into "fixing" BOS.
 */
export const BOS_OWNED_LOG_COMPONENTS: readonly string[] = [
  "assistant",
  "agent",
  "apps",
  "build-studio",
  "config",
  "devharness",
  "events",
  "gitfs",
  "gitops",
  "plugins",
  "scheduler",
  "self-heal",
  "specs",
  "system",
  "vfs",
];

/** Components that look BOS-owned by prefix but are third-party surfaces the
 *  mechanism must not act on (they live under an owned root). */
const EXCLUDED_LOG_COMPONENTS: readonly string[] = [
  "agent.mcp",
  "assistant.mcp",
  "integrations",
  "gsuite",
  "telegram",
  "mcp",
  "service.",
];

/** True when an error-level log event from `component` may trigger self-heal.
 *  Matching is on dot-separated prefixes, so `assistant.run-manager` is owned
 *  by `assistant` while `assistant.mcp.client` is explicitly excluded. */
export function isBosOwnedLogComponent(component: string | undefined): boolean {
  const c = (component ?? "").trim().toLowerCase();
  if (!c) return false;
  if (EXCLUDED_LOG_COMPONENTS.some((ex) => c === ex || c.startsWith(ex.endsWith(".") ? ex : `${ex}.`))) return false;
  return BOS_OWNED_LOG_COMPONENTS.some((owned) => c === owned || c.startsWith(`${owned}.`));
}
