// Audit trail for authentication attempts — simple provider only.
//
// The bastion is the only thing between the public Internet and every user's
// BOS container, so every credential check it performs is recorded here as one
// JSON Lines record appended to <dataDir>/audit/login.log.
//
// Why a separate file rather than log-store.ts: that module owns the per-user
// PROVISIONING log (<dataDir>/logs/<username>.log), which is surfaced in the
// admin UI and deleted along with the user (log-store.deleteLog). An audit
// trail must not live in a namespace keyed by — and erasable with — the very
// subject it records, and failed logins routinely name users that don't exist.
//
// Scope: only the simple provider. With Keycloak the IdP performs the
// credential check and owns that audit trail; the bastion never sees a
// password and would only be able to log "an OIDC callback succeeded/failed",
// which is not a login attempt record. initAuditLog() therefore disables this
// module outright for any non-simple provider, so a future caller cannot
// accidentally write a half-true Keycloak audit trail.

import fs from "fs";
import path from "path";

/** Rotate once the active file reaches this size. */
const MAX_BYTES = 5 * 1024 * 1024;
/** Number of rotated generations kept (login.log.1 … login.log.5). */
const KEEP = 5;
/** Caps on attacker-controlled strings, so one request cannot flood the log. */
const MAX_USERNAME = 128;
const MAX_UA = 256;

let logFile = "";
let enabled = false;
let warnedOnce = false;

/** Minimal structural shape of an express Request — keeps this module (and its
 *  tests) free of an express type dependency. */
export interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | null } | null;
}

export type LoginFailureReason =
  | "missing_credentials"
  | "unknown_user"
  | "bad_password"
  | "provider_error";

export interface AuditRecord {
  ts: string;
  /** "login" = a credential check; "bootstrap_admin" = the first-run setup
   *  route minting an admin session without one (the only other way to obtain
   *  a session under the simple provider). */
  event: "login" | "bootstrap_admin";
  outcome: "success" | "failure";
  username: string | null;
  reason: LoginFailureReason | null;
  isAdmin: boolean | null;
  /** Peer address of the TCP connection — trustworthy, but it is the reverse
   *  proxy's address whenever one is in front of the bastion. */
  ip: string;
  /** Raw X-Forwarded-For. Client-controlled and therefore spoofable unless a
   *  trusted proxy overwrites it; recorded verbatim beside `ip` rather than
   *  collapsed into it so the log never implies more certainty than it has. */
  forwardedFor: string;
  userAgent: string;
}

/** Enables the audit log for the simple provider and fixes its path. Must be
 *  called once at startup; until it is, every record() call is a no-op. */
export function initAuditLog(cfg: { dataDir: string; authProvider: string }): void {
  enabled = cfg.authProvider === "simple";
  logFile = path.join(cfg.dataDir, "audit", "login.log");
}

export function auditLogPath(): string {
  return logFile;
}

function truncate(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function headerValue(req: RequestLike, name: string): string {
  const raw = req.headers?.[name];
  if (Array.isArray(raw)) return raw.join(", ");
  return typeof raw === "string" ? raw : "";
}

/** Builds the record for an attempt. Exported for tests; pure. */
export function buildRecord(
  req: RequestLike,
  entry: {
    event: AuditRecord["event"];
    outcome: AuditRecord["outcome"];
    username?: unknown;
    reason?: LoginFailureReason;
    isAdmin?: boolean;
  },
  now: Date,
): AuditRecord {
  const username = truncate(entry.username, MAX_USERNAME);
  return {
    ts: now.toISOString(),
    event: entry.event,
    outcome: entry.outcome,
    username: username || null,
    reason: entry.reason ?? null,
    isAdmin: entry.isAdmin ?? null,
    ip: req.socket?.remoteAddress ?? "",
    forwardedFor: truncate(headerValue(req, "x-forwarded-for"), MAX_UA),
    userAgent: truncate(headerValue(req, "user-agent"), MAX_UA),
  };
}

/** Size-based rotation. Without it an unauthenticated attacker could fill the
 *  bastion's disk simply by POSTing to /login in a loop. */
function rotateIfNeeded(file: string): void {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch (err) {
    // No file yet — nothing to rotate. Anything else (EACCES on a data dir the
    // bastion cannot write, say) is a real fault: let it reach write()'s
    // handler so it is reported rather than silently skipping rotation.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (size < MAX_BYTES) return;
  for (let i = KEEP - 1; i >= 1; i--) {
    const from = `${file}.${i}`;
    if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i + 1}`);
  }
  fs.renameSync(file, `${file}.1`);
}

function write(record: AuditRecord): void {
  if (!enabled || !logFile) return;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    rotateIfNeeded(logFile);
    // JSON.stringify escapes newlines and control characters, so a username
    // like "alex\n{...forged record...}" cannot inject a second log line.
    fs.appendFileSync(logFile, `${JSON.stringify(record)}\n`);
  } catch (err) {
    // An audit write must never break the login it is recording. Warn once so
    // a misconfigured data dir is visible without spamming stderr per attempt.
    if (!warnedOnce) {
      warnedOnce = true;
      console.error(`[bastion] audit log write failed (${logFile}):`, err);
    }
  }
}

/** Records one credential check against POST /login. */
export function recordLoginAttempt(
  req: RequestLike,
  entry: { username?: unknown; outcome: "success" | "failure"; reason?: LoginFailureReason; isAdmin?: boolean },
): void {
  write(buildRecord(req, { ...entry, event: "login" }, new Date()));
}

/** Records first-run bootstrap creating the initial admin and handing out a
 *  session for it — a session granted without any credential check, and so the
 *  single most security-relevant event the simple provider can produce. */
export function recordBootstrapAdmin(req: RequestLike, username: string): void {
  write(
    buildRecord(
      req,
      { event: "bootstrap_admin", outcome: "success", username, isAdmin: true },
      new Date(),
    ),
  );
}
