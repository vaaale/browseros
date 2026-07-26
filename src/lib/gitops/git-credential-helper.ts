import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir } from "@/os/data-dir";
import { getSecretsStore } from "@/lib/integrations/secrets/store";
import { gitLogger } from "./logging";
import type { GitAuth } from "./auth";
import { HELPER_SOURCE, buildCredentialArgs, buildCredentialEnv } from "./git-credential-helper-script";

// ─────────────────────────────────────────────────────────────────────────────
// Git credential storage + a git credential helper for OAuth-protected remotes.
//
// Two concerns live here because they are two halves of the same story:
//
//   1. Canonical persistence of git-remote credentials in the SecretsStore.
//      Every reader/writer (OAuth callback, provider status, add/remove/rename
//      remote, auth resolution) MUST go through these helpers so the on-disk
//      keys stay consistent. All entries live under the `git_remote` store id
//      with a typed name prefix:
//        - `oauth:<providerId>`  → provider-wide OAuth token (shared by every
//                                  remote of that provider — this matches the
//                                  "connect once in Settings" model in the UI).
//        - `token:<remoteName>`  → per-remote personal access token.
//        - `ssh:<remoteName>`    → per-remote SSH private key.
//
//   2. A git credential helper. `GIT_TERMINAL_PROMPT=0` (set for headless/
//      container use) makes git fail instead of prompting when it needs a
//      username/password. Tokens are NEVER embedded in the remote URL — doing
//      so breaks git's URL parser (the token's `:` is misread as a port) and
//      leaks the token into argv. Instead the helper is the single auth path
//      for every HTTPS operation (clone, ls-remote, fetch, push): git invokes
//      it whenever it needs HTTPS credentials, and it echoes the token the BOS
//      git runner passed via environment variables. The token never touches
//      disk in plaintext and never appears in a process argument list.
// ─────────────────────────────────────────────────────────────────────────────

const STORE_ID = "git_remote";

export interface StoredOAuthToken {
  access_token: string;
  /** Epoch millis when the access token expires, if the provider returned it.
   *  GitHub OAuth Apps typically omit this (non-expiring tokens) unless the
   *  app owner enabled token expiration; GitLab always sets it. */
  expires_at?: number;
  /** Refresh token, if the provider issued one (GitLab always does; GitHub
   *  only for apps with token expiration enabled). Used by
   *  `refreshProviderOAuthToken` in `auth.ts` to silently renew an expiring
   *  access token instead of requiring the user to reconnect. */
  refresh_token?: string;
}

// ── Provider-wide OAuth token ────────────────────────────────────────────────

export async function setProviderOAuthToken(providerId: string, token: StoredOAuthToken): Promise<void> {
  await getSecretsStore().set(STORE_ID, `oauth:${providerId}`, token);
  // Never log the token itself — only that a token was stored.
  gitLogger().info({ op: "auth.setProviderOAuthToken", remote: providerId, success: true });
}

export async function getProviderOAuthToken(providerId: string): Promise<StoredOAuthToken | null> {
  return getSecretsStore().get<StoredOAuthToken>(STORE_ID, `oauth:${providerId}`);
}

export async function deleteProviderOAuthToken(providerId: string): Promise<void> {
  await getSecretsStore().delete(STORE_ID, `oauth:${providerId}`);
  gitLogger().info({ op: "auth.deleteProviderOAuthToken", remote: providerId, success: true });
}

// ── Per-remote personal access token ─────────────────────────────────────────

export async function setRemoteToken(remoteName: string, token: string): Promise<void> {
  await getSecretsStore().set(STORE_ID, `token:${remoteName}`, { token });
  gitLogger().info({ op: "auth.setRemoteToken", remote: remoteName, success: true });
}

export async function getRemoteToken(remoteName: string): Promise<string | null> {
  const data = await getSecretsStore().get<{ token: string }>(STORE_ID, `token:${remoteName}`);
  return data?.token ?? null;
}

// ── Per-remote SSH key ───────────────────────────────────────────────────────

export async function setRemoteSshKey(remoteName: string, keyData: string, passphrase?: string): Promise<void> {
  await getSecretsStore().set(STORE_ID, `ssh:${remoteName}`, { keyData, passphrase });
  gitLogger().info({ op: "auth.setRemoteSshKey", remote: remoteName, success: true });
}

export async function getRemoteSshKey(
  remoteName: string,
): Promise<{ keyData: string; passphrase?: string } | null> {
  return getSecretsStore().get<{ keyData: string; passphrase?: string }>(STORE_ID, `ssh:${remoteName}`);
}

// ── Lifecycle helpers (remove / rename a remote) ─────────────────────────────

/** Delete every per-remote credential (token + ssh) for a remote. */
export async function deleteRemoteCredentials(remoteName: string): Promise<void> {
  const store = getSecretsStore();
  await store.delete(STORE_ID, `token:${remoteName}`).catch(() => {});
  await store.delete(STORE_ID, `ssh:${remoteName}`).catch(() => {});
  gitLogger().info({ op: "auth.deleteRemoteCredentials", remote: remoteName, success: true });
}

/** Move per-remote credentials from one remote name to another (on rename). */
export async function renameRemoteCredentials(oldName: string, newName: string): Promise<void> {
  const store = getSecretsStore();
  for (const kind of ["token", "ssh"] as const) {
    const val = await store.get<Record<string, unknown>>(STORE_ID, `${kind}:${oldName}`).catch(() => null);
    if (val) {
      await store.set(STORE_ID, `${kind}:${newName}`, val);
      await store.delete(STORE_ID, `${kind}:${oldName}`).catch(() => {});
    }
  }
  gitLogger().info({ op: "auth.renameRemoteCredentials", remote: `${oldName} → ${newName}`, success: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// Credential helper script + git config
// ─────────────────────────────────────────────────────────────────────────────

const CRED_DIR = ".git-cred";
const CRED_SCRIPT = "credential-helper.cjs";

let cachedScriptPath: string | null = null;

/**
 * Materialise the credential-helper script under the data dir, idempotently,
 * and return its absolute path. Rewrites the file only when its content drifts
 * (e.g. after an upgrade) so concurrent git invocations see a stable file.
 */
export async function ensureCredentialHelperScript(): Promise<string> {
  const dir = path.join(dataDir(), CRED_DIR);
  const scriptPath = path.join(dir, CRED_SCRIPT);

  if (cachedScriptPath === scriptPath) return scriptPath;

  await fs.mkdir(dir, { recursive: true });
  let current: string | null = null;
  try {
    current = await fs.readFile(scriptPath, "utf8");
  } catch {
    current = null;
  }
  if (current !== HELPER_SOURCE) {
    await fs.writeFile(scriptPath, HELPER_SOURCE, { mode: 0o700 });
  }
  await fs.chmod(scriptPath, 0o700).catch(() => {});

  cachedScriptPath = scriptPath;
  return scriptPath;
}

export interface CredentialConfig {
  /** Extra `-c` arguments to place before the git subcommand. */
  args: string[];
  /** Environment variables carrying the credentials to the helper. */
  env: Record<string, string>;
}

/**
 * Build the per-invocation git configuration that wires up the credential
 * helper for an HTTPS token/OAuth auth. Returns empty args/env for SSH or
 * unauthenticated operations, so callers can apply it unconditionally.
 *
 * The token is passed as the password with username `oauth2`, matching the
 * `https://oauth2:<token>@host` form used elsewhere. GitHub and GitLab both
 * accept a token as the password with any non-empty username, so this works
 * for OAuth access tokens and personal access tokens alike.
 */
export async function buildCredentialConfig(auth?: GitAuth): Promise<CredentialConfig> {
  const token = auth?.accessToken ?? auth?.pat;
  if (!token) return { args: [], env: {} };

  try {
    const scriptPath = await ensureCredentialHelperScript();
    return {
      args: buildCredentialArgs(process.execPath, scriptPath),
      env: buildCredentialEnv(token),
    };
  } catch (err) {
    // Never let credential-helper setup failure break the whole git op; the op
    // will proceed unauthenticated and fail with a clear auth error if the
    // remote requires credentials.
    gitLogger().warn({
      op: "auth.credentialHelper",
      error: { code: "CRED_HELPER_SETUP_FAILED", message: (err as Error).message },
    });
    return { args: [], env: {} };
  }
}
