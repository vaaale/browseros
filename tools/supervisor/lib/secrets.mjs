import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createCipheriv, createDecipheriv } from "node:crypto";
import { slog } from "./log.mjs";

// Standalone copy of the read/write path in bastion/src/secrets-reader.ts,
// itself a copy of src/lib/integrations/secrets — the Supervisor is a
// separate, unbundled Node process (no imports from src/lib) but shares the
// same `data/` directory, so it can decrypt/encrypt the same on-disk secrets
// store directly instead of needing a running BOS server to do it. Unlike the
// bastion's fixed `<file>.tmp` temp name, writes here use a pid+random temp
// name (matching src/os/atomic-write.ts) so a concurrent writer (the bastion,
// or the main app) can never collide on the SAME temp path — worst case
// across independent writers remains a last-write-wins on the final rename,
// never a corrupted temp file.

function toB64Url(b) {
  return b.toString("base64url");
}

function fromB64Url(s) {
  return Buffer.from(s, "base64url");
}

function aesDecrypt(sealed, key) {
  const decipher = createDecipheriv("aes-256-gcm", key, fromB64Url(sealed.iv));
  decipher.setAuthTag(fromB64Url(sealed.tag));
  return Buffer.concat([decipher.update(fromB64Url(sealed.ciphertext)), decipher.final()]).toString("utf8");
}

function aesEncrypt(plaintext, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { iv: toB64Url(iv), ciphertext: toB64Url(enc), tag: toB64Url(cipher.getAuthTag()) };
}

function writeFileAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

function loadKey(dataDir) {
  try {
    const buf = fs.readFileSync(path.join(dataDir, ".integrations-key"));
    return buf.length === 32 ? buf : null;
  } catch (e) {
    if (e?.code !== "ENOENT") slog("warn", "secrets", `reading encryption key in ${dataDir} failed: ${e?.message || e}`);
    return null;
  }
}

function loadDisk(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, "integrations", "secrets.json"), "utf8"));
    if (parsed?.version !== 1 || typeof parsed.entries !== "object") return null;
    return parsed;
  } catch (e) {
    // ENOENT (no secrets stored yet) is the expected, silent case. Anything
    // else — malformed JSON, a permissions error — means an EXISTING secrets
    // file couldn't be read, which every caller then reads as "no credential
    // configured" with zero indication that one may have been lost.
    if (e?.code !== "ENOENT") slog("warn", "secrets", `reading secrets.json in ${dataDir} failed: ${e?.message || e}`);
    return null;
  }
}

function getDecrypted(dataDir, storeKey) {
  const key = loadKey(dataDir);
  const disk = loadDisk(dataDir);
  if (!key || !disk) return null;
  const sealed = disk.entries[storeKey];
  if (!sealed) return null;
  try {
    return JSON.parse(aesDecrypt(sealed, key));
  } catch (e) {
    // The entry exists but wouldn't decrypt (wrong key, tampered/corrupted
    // data) — a genuinely different situation from "no credential stored",
    // which every caller otherwise can't tell apart from this.
    slog("warn", "secrets", `decrypting stored secret "${storeKey}" in ${dataDir} failed: ${e?.message || e}`);
    return null;
  }
}

/**
 * Encrypt `value` and persist it at `storeKey`, matching BOS's SecretsStore
 * on-disk format exactly (same file, same envelope shape). Returns false
 * (rather than throwing) only when the encryption key itself is missing —
 * every other failure (disk full, permissions, …) throws, since a silent
 * no-op there would hide a refreshed token that was never actually saved.
 */
export function setEncrypted(dataDir, storeKey, value) {
  const key = loadKey(dataDir);
  if (!key) return false;
  const disk = loadDisk(dataDir) ?? { version: 1, entries: {} };
  disk.entries[storeKey] = aesEncrypt(JSON.stringify(value), key);
  writeFileAtomic(path.join(dataDir, "integrations", "secrets.json"), JSON.stringify(disk, null, 2));
  fs.chmodSync(path.join(dataDir, "integrations", "secrets.json"), 0o600);
  return true;
}

/** OAuth client id/secret for `providerId`, decrypted from
 *  `git_remote_oauth:<providerId>:client` — same key BOS's Settings → Git
 *  Providers writes when a provider is configured. */
export function getGitProviderCredentials(dataDir, providerId) {
  return getDecrypted(dataDir, `git_remote_oauth:${providerId}:client`);
}

/** The FULL stored OAuth token for `providerId`, including `refresh_token` —
 *  unlike resolveRemoteToken(), which projects to `{token, expiresAt}` for
 *  git-credential callers that never need to see the refresh token itself. */
export function getStoredOAuthToken(dataDir, providerId) {
  return getDecrypted(dataDir, `git_remote:oauth:${providerId}`);
}

/** Persist a freshly refreshed OAuth token for `providerId`. */
export function setProviderOAuthToken(dataDir, providerId, token) {
  return setEncrypted(dataDir, `git_remote:oauth:${providerId}`, token);
}

/** Mirror a refreshed token's expiry onto every `git-remotes.json` entry for
 *  `provider`, matching src/lib/gitops/auth.ts's refreshProviderOAuthToken —
 *  purely cosmetic (Settings UI reads it for display) but worth keeping
 *  consistent so the two writers never visibly disagree. Best-effort: a
 *  failure here must not fail the refresh itself, since the token is already
 *  safely persisted by the time this runs. */
export function updateRemoteOauthExpiry(dataDir, provider, expiresAt) {
  const file = path.join(dataDir, "config", "git-remotes.json");
  let configs;
  try {
    configs = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e?.code !== "ENOENT") slog("warn", "secrets", `reading git-remotes.json in ${dataDir} failed (expiry mirror skipped): ${e?.message || e}`);
    return;
  }
  if (!Array.isArray(configs)) return;
  let changed = false;
  for (const c of configs) {
    if (c && c.provider === provider) {
      c.oauthTokenExpiresAt = expiresAt;
      changed = true;
    }
  }
  if (!changed) return;
  try {
    writeFileAtomic(file, JSON.stringify(configs, null, 2));
  } catch (e) {
    // Best-effort mirror only (see doc comment above) — but still worth
    // knowing the display value is now stale.
    slog("warn", "secrets", `writing git-remotes.json expiry mirror in ${dataDir} failed: ${e?.message || e}`);
  }
}

/**
 * Resolve the HTTPS token for a git remote. Returns null if the remote uses
 * SSH auth or has no stored credential (unauthenticated fetch is then the
 * caller's fallback, same as before this existed).
 */
export function resolveRemoteToken(dataDir, remoteName, authType, provider) {
  if (!authType || authType === "ssh") return null;
  if (authType === "oauth") {
    if (!provider) return null;
    const data = getDecrypted(dataDir, `git_remote:oauth:${provider}`);
    return data?.access_token ? { token: data.access_token, expiresAt: data.expires_at } : null;
  }
  const data = getDecrypted(dataDir, `git_remote:token:${remoteName}`);
  return data?.token ? { token: data.token } : null;
}

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

function ensureCredentialHelper(dataDir) {
  const dir = path.join(dataDir, ".git-cred");
  const scriptPath = path.join(dir, "credential-helper.cjs");
  fs.mkdirSync(dir, { recursive: true });
  let current = null;
  try { current = fs.readFileSync(scriptPath, "utf8"); } catch { /* not found */ }
  // Atomic (temp + rename), not a direct in-place write: under hardlink-farm
  // isolation this path can share its inode with base's and every other
  // preview's copy until first written — a write-in-place would be visible,
  // mid-write, to all of them at once (the exact hazard the project's own
  // atomic-writes contract exists to rule out).
  if (current !== HELPER_SOURCE) writeFileAtomic(scriptPath, HELPER_SOURCE);
  fs.chmodSync(scriptPath, 0o700);
  return scriptPath;
}

/**
 * Build the git `-c` args and env vars that wire up the credential helper
 * for a token/OAuth remote.
 */
export function buildGitCredential(dataDir, token) {
  const scriptPath = ensureCredentialHelper(dataDir);
  const helperCmd = `!"${process.execPath}" "${scriptPath}"`;
  return {
    args: ["-c", "credential.helper=", "-c", `credential.helper=${helperCmd}`],
    env: { BOS_GIT_CRED_USERNAME: "oauth2", BOS_GIT_CRED_PASSWORD: token },
  };
}
