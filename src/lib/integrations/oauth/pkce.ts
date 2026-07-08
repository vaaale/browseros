// PKCE (RFC 7636) helpers — framework-free but uses node:crypto (server-only
// import gate is enforced by callers, this file itself is only ever imported
// from server code).

import { createHash, randomBytes } from "crypto";

/** Fresh code_verifier: 32 random bytes, base64url-encoded (~43 chars). */
export function newVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/** code_challenge = base64url(sha256(verifier)). Method S256. */
export function challengeFromVerifier(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
