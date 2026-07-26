import fs from "fs";
import path from "path";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

// Mirrors the AES-256-GCM format in src/lib/integrations/secrets/crypto.ts.
// The bastion runs outside the BOS container so it can't import that module;
// this standalone copy reads the same on-disk format.

interface Sealed {
  iv: string;
  ciphertext: string;
  tag: string;
}

interface OnDisk {
  version: 1;
  entries: Record<string, Sealed>;
}

function toB64Url(b: Buffer): string {
  return b.toString("base64url");
}

function fromB64Url(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

function aesDecrypt(sealed: Sealed, key: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, fromB64Url(sealed.iv));
  decipher.setAuthTag(fromB64Url(sealed.tag));
  return Buffer.concat([decipher.update(fromB64Url(sealed.ciphertext)), decipher.final()]).toString("utf8");
}

function aesEncrypt(plaintext: string, key: Buffer): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { iv: toB64Url(iv), ciphertext: toB64Url(enc), tag: toB64Url(cipher.getAuthTag()) };
}

function loadKey(dataDir: string): Buffer | null {
  const p = path.join(dataDir, ".integrations-key");
  try {
    const buf = fs.readFileSync(p);
    return buf.length === 32 ? buf : null;
  } catch {
    return null;
  }
}

function loadDisk(dataDir: string): OnDisk | null {
  const p = path.join(dataDir, "integrations", "secrets.json");
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as OnDisk;
    if (parsed?.version !== 1 || typeof parsed.entries !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function getDecrypted<T>(dataDir: string, storeKey: string): T | null {
  const key = loadKey(dataDir);
  const disk = loadDisk(dataDir);
  if (!key || !disk) return null;
  const sealed = disk.entries[storeKey];
  if (!sealed) return null;
  try {
    return JSON.parse(aesDecrypt(sealed, key)) as T;
  } catch {
    return null;
  }
}

/** Encrypt `value` and persist it at `storeKey`, matching BOS's SecretsStore
 *  on-disk format exactly (same file, same atomic temp+rename write). */
function setEncrypted(dataDir: string, storeKey: string, value: unknown): boolean {
  const key = loadKey(dataDir);
  if (!key) return false;
  const disk = loadDisk(dataDir) ?? { version: 1, entries: {} };
  disk.entries[storeKey] = aesEncrypt(JSON.stringify(value), key);
  const dir = path.join(dataDir, "integrations");
  const file = path.join(dir, "secrets.json");
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(disk, null, 2));
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  return true;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface RemoteToken {
  token: string;
  /** Epoch millis when this token expires, if known (oauth only). */
  expiresAt?: number;
}

/**
 * Resolve the HTTPS token for a git remote.
 * Returns null if the remote uses SSH auth or has no stored credential.
 *
 * authType "token"  → key "git_remote:token:<remoteName>"  → { token }
 * authType "oauth"  → key "git_remote:oauth:<provider>"     → { access_token, expires_at? }
 *
 * Note: this does NOT refresh an expiring/expired OAuth token — neither does
 * BOS's own src/lib/gitops/auth.ts resolveAuth(). Caller should surface
 * expiresAt so a rejected fetch is diagnosable instead of guessed at.
 */
export function resolveRemoteToken(
  dataDir: string,
  remoteName: string,
  authType: "token" | "oauth" | "ssh" | undefined,
  provider?: string,
): RemoteToken | null {
  if (!authType || authType === "ssh") return null;

  if (authType === "oauth") {
    if (!provider) return null;
    const data = getDecrypted<{ access_token: string; expires_at?: number }>(dataDir, `git_remote:oauth:${provider}`);
    return data?.access_token ? { token: data.access_token, expiresAt: data.expires_at } : null;
  }

  // token
  const data = getDecrypted<{ token: string }>(dataDir, `git_remote:token:${remoteName}`);
  return data?.token ? { token: data.token } : null;
}

// ── OAuth refresh ─────────────────────────────────────────────────────────────
//
// Mirrors src/lib/gitops/auth.ts's refreshProviderOAuthToken. Duplicated here
// (rather than imported) because the bastion runs outside the BOS container
// and must work even when BOS isn't running — the whole point of "Update
// Source" recovering a container that won't start.

interface GitProviderClientCreds {
  clientId: string;
  clientSecret: string;
  instanceUrl?: string;
}

function resolveOAuthTokenUrl(providerId: string, instanceUrl?: string): string | null {
  if (providerId === "github") return "https://github.com/login/oauth/access_token";
  if (providerId === "gitlab") {
    const base = (instanceUrl?.trim() || "https://gitlab.com").replace(/\/$/, "");
    return `${base}/oauth/token`;
  }
  return null;
}

export interface OAuthRefreshResult {
  ok: boolean;
  accessToken?: string;
  error?: string;
  /** True when the refresh token itself is dead — reconnect required in BOS. */
  reconnectRequired?: boolean;
}

/**
 * Refresh a git-remotes OAuth access token using its stored refresh_token.
 * No-op failure (reconnectRequired: true) when there's no refresh_token on
 * file — the normal case for a GitHub OAuth App without token expiration
 * enabled, where the access_token simply never expires.
 */
export async function refreshOAuthToken(dataDir: string, providerId: string): Promise<OAuthRefreshResult> {
  const stored = getDecrypted<{ access_token: string; expires_at?: number; refresh_token?: string }>(
    dataDir,
    `git_remote:oauth:${providerId}`,
  );
  if (!stored?.refresh_token) {
    return { ok: false, error: "No refresh token on file — reconnect required.", reconnectRequired: true };
  }

  const creds = getDecrypted<GitProviderClientCreds>(dataDir, `git_remote_oauth:${providerId}:client`);
  if (!creds?.clientId || !creds?.clientSecret) {
    return { ok: false, error: `No OAuth client credentials configured for '${providerId}'.` };
  }

  const tokenUrl = resolveOAuthTokenUrl(providerId, creds.instanceUrl);
  if (!tokenUrl) return { ok: false, error: `Unknown OAuth provider '${providerId}'.` };

  let res: Response;
  try {
    res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: stored.refresh_token,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      }).toString(),
    });
  } catch (e) {
    return { ok: false, error: `Refresh request failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const desc = (body.error_description as string) ?? (body.error as string) ?? `HTTP ${res.status}`;
    return { ok: false, error: desc, reconnectRequired: body.error === "invalid_grant" };
  }

  const accessToken = body.access_token as string | undefined;
  if (!accessToken) return { ok: false, error: "Provider did not return access_token on refresh." };
  const expiresIn = body.expires_in as number | undefined;
  // GitLab rotates the refresh token on every use — always persist whatever
  // the response sends, falling back to the old one if it sent none.
  const newRefreshToken = (body.refresh_token as string | undefined) ?? stored.refresh_token;

  const wrote = setEncrypted(dataDir, `git_remote:oauth:${providerId}`, {
    access_token: accessToken,
    refresh_token: newRefreshToken,
    ...(typeof expiresIn === "number" ? { expires_at: Date.now() + expiresIn * 1000 } : {}),
  });
  if (!wrote) return { ok: false, error: "Could not persist refreshed token (missing encryption key)." };

  return { ok: true, accessToken };
}

// ── Credential helper script ──────────────────────────────────────────────────

// Mirrors src/lib/gitops/git-credential-helper-script.ts HELPER_SOURCE exactly.
const HELPER_SOURCE = `#!/usr/bin/env node
"use strict";
const op = process.argv[2];
if (op !== "get") { process.exit(0); }
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", function (chunk) { input += chunk; });
process.stdin.on("end", function () {
  const username = process.env.BOS_GIT_CRED_USERNAME || "oauth2";
  const password = process.env.BOS_GIT_CRED_PASSWORD || "";
  if (!password) { process.exit(0); }
  process.stdout.write("username=" + username + "\\npassword=" + password + "\\n");
});
`;

/**
 * Ensure the git credential helper script exists in data/.git-cred/ and return
 * its path. If BOS has already written it this is a no-op (content matches).
 */
export function ensureCredentialHelper(dataDir: string): string {
  const dir = path.join(dataDir, ".git-cred");
  const scriptPath = path.join(dir, "credential-helper.cjs");
  fs.mkdirSync(dir, { recursive: true });
  let current: string | null = null;
  try { current = fs.readFileSync(scriptPath, "utf8"); } catch { /* not found */ }
  if (current !== HELPER_SOURCE) fs.writeFileSync(scriptPath, HELPER_SOURCE, { mode: 0o700 });
  fs.chmodSync(scriptPath, 0o700);
  return scriptPath;
}

/**
 * Build the git `-c` args and env vars that wire up the credential helper for
 * a token/OAuth remote. Returns empty objects for SSH or unauthenticated remotes.
 */
export function buildGitCredential(
  dataDir: string,
  token: string,
): { args: string[]; env: Record<string, string> } {
  const scriptPath = ensureCredentialHelper(dataDir);
  const node = process.execPath;
  const helperCmd = `!"${node}" "${scriptPath}"`;
  return {
    args: ["-c", "credential.helper=", "-c", `credential.helper=${helperCmd}`],
    env: { BOS_GIT_CRED_USERNAME: "oauth2", BOS_GIT_CRED_PASSWORD: token },
  };
}
