import "server-only";
import type { NextRequest } from "next/server";

// Trusted-claim consumption for the "generic secret" mechanism
// (034-secrets-authentication). Bastion (bastion/src/proxy.ts) is the ONLY
// place that ever verifies a raw credential — a session JWT's signature, or
// a presented secret's hash against credentials-index.json — and asserts the
// verified result downstream as sanitized `x-bos-auth-scope`/`x-bos-auth-role`
// headers, stripping any client-supplied value first. Code in this container
// must never re-verify a raw credential itself; it only ever consumes these
// already-verified claims. This is the same "gateway verifies, origin trusts
// an injected header" pattern any JWT-terminating reverse proxy uses.
//
// `x-bos-auth-scope` is exactly one of:
//   "session"          — a verified browser session (Bastion's SessionPayload)
//   "secret:<service>" — a headless request routed by a per-service secret,
//                        never validated as a session at all
// absent entirely      — the request never crossed Bastion (a same-container
//                        loopback call, or this instance isn't running behind
//                        a Supervisor/Bastion at all)

const AUTH_SCOPE_HEADER = "x-bos-auth-scope";

/** True when this BOS instance is running behind a Supervisor/Bastion
 *  (multi-user) — the only deployment mode where `x-bos-auth-scope` is ever
 *  set or meaningful. Matches the same env-var check used elsewhere for this
 *  distinction (e.g. `src/app/api/system/session/route.ts`). */
export function multiUserMode(): boolean {
  return !!process.env.BOS_PUBLIC_PORT;
}

/** Whether the incoming request is permitted to perform a session-only
 *  (browser-authenticated) operation — minting/listing/revoking a secret, or
 *  any future admin-only surface. A per-service secret NEVER satisfies this,
 *  regardless of which service minted it or how "valid" it is for its own
 *  narrow purpose — Bastion asserts "session" only for a verified session,
 *  never for a routed secret (see proxy.ts). In standalone/plain-dev mode
 *  (no Supervisor/Bastion in front at all) there is nothing to check — the
 *  whole container is already a single local user's trust boundary. */
export function hasSessionScope(req: NextRequest): boolean {
  if (!multiUserMode()) return true;
  return req.headers.get(AUTH_SCOPE_HEADER) === "session";
}

/** Whether the incoming request carries NO Bastion-asserted scope at all —
 *  meaning it never crossed Bastion (a genuine same-container loopback call,
 *  the only kind a service's own worker thread ever makes to verify a
 *  candidate secret), or this instance isn't running behind a Supervisor at
 *  all. Restricts a route to loopback-only callers without inventing a
 *  separate "is this really 127.0.0.1" mechanism: Bastion ALWAYS sets this
 *  header to something (session or secret:<service>) for any request that
 *  actually crossed it, so its absence is the reliable signal. */
export function isLoopbackOnly(req: NextRequest): boolean {
  if (!multiUserMode()) return true;
  return req.headers.get(AUTH_SCOPE_HEADER) === null;
}
