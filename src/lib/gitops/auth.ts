import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { dataDir } from "@/os/data-dir";
import { getSecretsStore } from "@/lib/integrations/secrets/store";
import { getOAuthProvider, getGitLabAuthUrls } from "@/lib/integrations/oauth/providers";
import { gitLogger } from "./logging";
import { testConnection, type GitError } from "./git-ops";
import { getProviderOAuthToken, setProviderOAuthToken, getRemoteToken, getRemoteSshKey, type StoredOAuthToken } from "./git-credential-helper";
import { readRemoteConfigs, updateRemoteConfig } from "./remote-config";

// Auth resolution for git operations. Reads credentials from SecretsStore
// and configures git auth env / URL-embedded tokens.

export type AuthType = "oauth" | "token" | "ssh";

export interface GitAuth {
  type: AuthType;
  /** OAuth access token. */
  accessToken?: string;
  /** Personal access token. */
  pat?: string;
  /** Path to decrypted SSH key file (temporary). */
  sshKeyPath?: string;
  /** Raw SSH key data. */
  sshKeyData?: string;
}

interface SshKeyCleanup {
  sshKeyPath: string;
  cleanup: () => Promise<void>;
}

const SSH_KEYS_DIR = ".ssh-keys";

// ── resolveAuth ──────────────────────────────────────────────────────────────

export async function resolveAuth(
  remoteName: string,
  authType: AuthType,
  provider?: string,
): Promise<GitAuth | null> {
  const op = "auth.resolve";
  gitLogger().debug({ op, remote: remoteName });

  try {
    switch (authType) {
      case "oauth": {
        // OAuth is provider-wide (connected once in Settings → Git Providers),
        // so the token is keyed by provider, not remote name.
        if (!provider) return null;
        const tokens = await getProviderOAuthToken(provider);
        if (!tokens?.access_token) return null;

        // Refresh preemptively if the token is expired or about to be — GitLab
        // tokens live only ~2 hours, so this keeps every git op working without
        // the user ever needing to manually reconnect. No-op when the provider
        // doesn't record an expiry (e.g. a non-expiring GitHub OAuth App token).
        if (tokens.expires_at !== undefined && tokens.expires_at - Date.now() < REFRESH_BUFFER_MS) {
          const refreshed = await refreshProviderOAuthToken(provider);
          if (refreshed.ok && refreshed.accessToken) {
            return { type: "oauth", accessToken: refreshed.accessToken };
          }
          gitLogger().warn({
            op: "auth.resolve",
            remote: remoteName,
            error: { code: "OAUTH_REFRESH_FAILED", message: refreshed.error ?? "unknown error" },
          });
          // Fall through with the stale token — the actual git operation will
          // surface a clear auth error if it's truly unusable.
        }
        return { type: "oauth", accessToken: tokens.access_token };
      }
      case "token": {
        const token = await getRemoteToken(remoteName);
        if (!token) return null;
        return { type: "token", pat: token };
      }
      case "ssh": {
        const data = await getRemoteSshKey(remoteName);
        if (!data?.keyData) return null;
        return { type: "ssh", sshKeyData: data.keyData };
      }
      default:
        return null;
    }
  } catch (err) {
    const message = (err as Error).message;
    gitLogger().error({ op, remote: remoteName, error: { code: "AUTH_RESOLVE_FAILED", message } });
    return null;
  }
}

// ── configureSshAuth ─────────────────────────────────────────────────────────

export async function configureSshAuth(
  sshKeyData: string,
  passphrase?: string,
): Promise<SshKeyCleanup> {
  const op = "auth.configureSsh";
  gitLogger().debug({ op });

  const keysDir = path.join(dataDir(), SSH_KEYS_DIR);
  await fs.mkdir(keysDir, { recursive: true });

  const keyFileName = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.key`;
  const keyPath = path.join(keysDir, keyFileName);

  // Write key with restricted permissions.
  await writeFile(keyPath, sshKeyData, { mode: 0o600 });

  // If passphrase is provided, write it to a companion file for ssh-add.
  // (In practice, passphrases should only be provided via secure UI channel.)
  if (passphrase) {
    const passPath = keyPath + ".pass";
    await writeFile(passPath, passphrase, { mode: 0o600 });
  }

  gitLogger().debug({ op, repoPath: keyPath });

  const cleanup = async (): Promise<void> => {
    // A decrypted SSH private key (or its passphrase) left on disk is a real
    // security exposure, not a cosmetic one — a failed cleanup must be loud,
    // not silently swallowed, so an operator can find and remove it.
    try {
      await fs.rm(keyPath, { force: true });
    } catch (err) {
      gitLogger().error({ op, repoPath: keyPath, error: { code: "SSH_KEY_CLEANUP_FAILED", message: `failed to remove temporary SSH key at ${keyPath}: ${(err as Error).message}` } });
    }
    if (passphrase) {
      try {
        await fs.rm(keyPath + ".pass", { force: true });
      } catch (err) {
        gitLogger().error({ op, repoPath: `${keyPath}.pass`, error: { code: "SSH_KEY_CLEANUP_FAILED", message: `failed to remove temporary SSH passphrase file at ${keyPath}.pass: ${(err as Error).message}` } });
      }
    }
  };

  return { sshKeyPath: keyPath, cleanup };
}

// ── validateAuth ─────────────────────────────────────────────────────────────

export async function validateAuth(
  url: string,
  auth: GitAuth,
): Promise<{ ok: boolean; error?: string }> {
  const op = "auth.validate";
  gitLogger().debug({ op, remote: url });

  try {
    const result = await testConnection(url, auth);
    if (result.ok) {
      gitLogger().info({ op, remote: url, success: true });
      return { ok: true };
    }
    gitLogger().warn({ op, remote: url, success: false, error: { code: "AUTH_VALIDATION_FAILED", message: result.error ?? "Connection failed" } });
    return { ok: false, error: result.error };
  } catch (err) {
    const message = (err as GitError).message ?? (err as Error).message;
    gitLogger().error({ op, remote: url, error: { code: "AUTH_VALIDATION_FAILED", message } });
    return { ok: false, error: message };
  }
}

// ── refreshProviderOAuthToken ───────────────────────────────────────────────

// Refresh if the token expires within this window — short on purpose (git
// remotes' tokens are typically short-lived, e.g. GitLab's ~2h), so this only
// fires close to actual expiry rather than on every single git operation.
const REFRESH_BUFFER_MS = 2 * 60_000;

export interface OAuthRefreshResult {
  ok: boolean;
  accessToken?: string;
  /** Human-readable reason when ok is false. */
  error?: string;
  /** True when the refresh token itself is dead (e.g. revoked) — the user
   *  must fully reconnect in Settings → Integrations → Git Providers. */
  reconnectRequired?: boolean;
}

/**
 * Refresh a git-remotes OAuth access token using its stored refresh_token.
 * Provider-wide, same scoping as the token itself (see StoredOAuthToken).
 * Returns `reconnectRequired: true` when there's no refresh_token on file —
 * this is the normal case for a GitHub OAuth App without token expiration
 * enabled, where the original access_token simply never expires and this
 * function is never reached (resolveAuth only calls it when expires_at is set
 * and imminent).
 */
export async function refreshProviderOAuthToken(providerId: string): Promise<OAuthRefreshResult> {
  const op = "auth.refreshOAuthToken";
  try {
    const stored = await getProviderOAuthToken(providerId);
    if (!stored?.refresh_token) {
      return {
        ok: false,
        error: "No refresh token on file — reconnect required.",
        reconnectRequired: true,
      };
    }

    const creds = await getSecretsStore().getGitProviderCredentials(providerId);
    if (!creds?.clientId || !creds?.clientSecret) {
      return { ok: false, error: `No OAuth client credentials configured for '${providerId}'.` };
    }

    const providerManifest = getOAuthProvider(providerId);
    const tokenUrl = providerId === "gitlab" ? getGitLabAuthUrls(creds.instanceUrl).tokenUrl : providerManifest?.tokenUrl;
    if (!tokenUrl) {
      return { ok: false, error: `No token URL for provider '${providerId}'.` };
    }

    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: stored.refresh_token,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      }).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

    if (!res.ok) {
      const desc = (body.error_description as string) ?? (body.error as string) ?? `HTTP ${res.status}`;
      const reconnectRequired = body.error === "invalid_grant";
      gitLogger().error({ op, provider: providerId, error: { code: "OAUTH_REFRESH_FAILED", message: desc } });
      return { ok: false, error: desc, reconnectRequired };
    }

    const accessToken = body.access_token as string | undefined;
    if (!accessToken) {
      return { ok: false, error: "Provider did not return access_token on refresh." };
    }
    const expiresIn = body.expires_in as number | undefined;
    // GitLab rotates the refresh token on every use — always persist whatever
    // the response sends, falling back to the old one if it sent none.
    const newRefreshToken = (body.refresh_token as string | undefined) ?? stored.refresh_token;

    const newToken: StoredOAuthToken = {
      access_token: accessToken,
      refresh_token: newRefreshToken,
      ...(typeof expiresIn === "number" ? { expires_at: Date.now() + expiresIn * 1000 } : {}),
    };
    await setProviderOAuthToken(providerId, newToken);

    // Keep remote-config metadata (used for UI display) in sync.
    const configs = readRemoteConfigs();
    for (const remoteConfig of configs.filter((c) => c.provider === providerId)) {
      updateRemoteConfig(remoteConfig.name, { oauthTokenExpiresAt: newToken.expires_at });
    }

    gitLogger().info({ op, provider: providerId, success: true });
    return { ok: true, accessToken };
  } catch (err) {
    const message = (err as Error).message;
    gitLogger().error({ op, provider: providerId, error: { code: "OAUTH_REFRESH_FAILED", message } });
    return { ok: false, error: message };
  }
}
