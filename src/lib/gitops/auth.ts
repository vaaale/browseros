import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chmod, writeFile } from "node:fs/promises";
import { dataDir } from "@/os/data-dir";
import { getSecretsStore } from "@/lib/integrations/secrets/store";
import { getOAuthManager } from "@/lib/integrations/oauth/manager";
import { gitLogger } from "./logging";
import { testConnection, type GitError } from "./git-ops";

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
): Promise<GitAuth | null> {
  const op = "auth.resolve";
  gitLogger().debug({ op, remote: remoteName });

  try {
    const store = getSecretsStore();
    const key = `git_remote:${remoteName}:${authType}`;

    switch (authType) {
      case "oauth": {
        const tokens = await store.get<{ access_token: string }>(key, "credential");
        if (!tokens?.access_token) return null;
        return { type: "oauth", accessToken: tokens.access_token };
      }
      case "token": {
        const data = await store.get<{ token: string }>(key, "credential");
        if (!data?.token) return null;
        return { type: "token", pat: data.token };
      }
      case "ssh": {
        const data = await store.get<{ keyData: string; passphrase?: string }>(key, "credential");
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

// ── applyAuthToUrl ───────────────────────────────────────────────────────────

export function applyAuthToUrl(url: string, auth: GitAuth): string | null {
  const op = "auth.applyToUrl";
  gitLogger().debug({ op, remote: url });

  // Reject git:// protocol.
  if (url.startsWith("git://")) {
    gitLogger().warn({ op, remote: url, error: { code: "AUTH_PROTOCOL_REJECTED", message: "git:// protocol is not supported" } });
    return null;
  }

  const token = auth.accessToken ?? auth.pat;
  if (!token) return url;

  // Embed token in HTTPS URL: https://oauth2:TOKEN@host/...
  return url.replace(/^(https?:\/\/)/, `$1oauth2:${token}@`);
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
    try {
      await fs.rm(keyPath, { force: true });
      if (passphrase) {
        await fs.rm(keyPath + ".pass", { force: true });
      }
    } catch {
      // Best effort cleanup.
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

// ── isTokenExpiringSoon ──────────────────────────────────────────────────────

export function isTokenExpiringSoon(tokenExpiry: number): boolean {
  // Token is expiring if it expires within 24 hours.
  const twentyFourHoursMs = 24 * 60 * 60 * 1000;
  return tokenExpiry - Date.now() < twentyFourHoursMs;
}

// ── maybeRefreshOAuth ────────────────────────────────────────────────────────

export async function maybeRefreshOAuth(
  integrationId: string,
  remoteName: string,
): Promise<{ refreshed: boolean; newToken?: string; error?: string }> {
  const op = "auth.maybeRefreshOAuth";
  gitLogger().debug({ op, remote: remoteName });

  try {
    const store = getSecretsStore();
    const tokens = await store.get<{ access_token: string; expires_at: number }>(
      integrationId,
      "tokens",
    );

    if (!tokens) {
      return { refreshed: false, error: "No tokens found for integration" };
    }

    if (!isTokenExpiringSoon(tokens.expires_at)) {
      gitLogger().debug({ op, remote: remoteName });
      return { refreshed: false };
    }

    // Token is expiring — refresh it.
    const manager = getOAuthManager();
    const refreshed = await manager.refreshToken(integrationId);
    const newToken = refreshed.access_token;

    gitLogger().info({ op, remote: remoteName, success: true });
    return { refreshed: true, newToken };
  } catch (err) {
    const message = (err as Error).message;
    gitLogger().error({ op, remote: remoteName, error: { code: "OAUTH_REFRESH_FAILED", message } });
    return { refreshed: false, error: message };
  }
}
