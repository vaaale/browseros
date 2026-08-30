import {
  resolveRemoteToken,
  buildGitCredential,
  getGitProviderCredentials,
  getStoredOAuthToken,
  setProviderOAuthToken,
  updateRemoteOauthExpiry,
} from "./secrets.mjs";
import { slog } from "./log.mjs";

// Refresh-aware wrapper around the Supervisor's one authenticated git call
// (preview.mjs's pullBaseBeforeNewBranch). Without this, an expired GitLab
// OAuth token fails every `begin` until BOS's own main app happens to
// refresh it via unrelated git activity — a real incident: the Supervisor
// sat broken for ~10 minutes because nothing here could refresh its own
// credential. Storage (encrypt/decrypt secrets.json, git-remotes.json) stays
// in secrets.mjs; this module owns the retry/refresh policy.

const REFRESH_BUFFER_MS = 2 * 60_000; // matches src/lib/gitops/auth.ts

// Detects an auth-type git failure. Single source of truth — was previously
// duplicated in push.mjs (itself mirroring src/lib/gitops/git-ops.ts's
// isAuthFailure); push.mjs now imports it from here.
export function isGitAuthFailure(message) {
  return (
    /authentication/i.test(message) ||
    /permission denied/i.test(message) ||
    /fatal: .*(?:token|credential)/i.test(message) ||
    /401/.test(message) ||
    /403/.test(message) ||
    /could not read (username|password)/i.test(message) ||
    /terminal prompts disabled/i.test(message)
  );
}

function resolveOAuthTokenUrl(providerId, instanceUrl) {
  if (providerId === "github") return "https://github.com/login/oauth/access_token";
  if (providerId === "gitlab") {
    const base = (instanceUrl?.trim() || "https://gitlab.com").replace(/\/$/, "");
    return `${base}/oauth/token`;
  }
  return null;
}

/**
 * Refresh `providerId`'s OAuth access token using its stored refresh_token.
 * Full port of src/lib/gitops/auth.ts's refreshProviderOAuthToken (also
 * live-proven in bastion/src/secrets-reader.ts's refreshOAuthToken) — the
 * Supervisor is a separate, unbundled Node process with no import access to
 * either, so it needs its own copy to decrypt/refresh the same on-disk store.
 */
export async function refreshOAuthToken(dataDir, providerId) {
  const stored = getStoredOAuthToken(dataDir, providerId);
  if (!stored?.refresh_token) {
    return { ok: false, error: "No refresh token on file — reconnect required.", reconnectRequired: true };
  }

  const creds = getGitProviderCredentials(dataDir, providerId);
  if (!creds?.clientId || !creds?.clientSecret) {
    return { ok: false, error: `No OAuth client credentials configured for '${providerId}'.` };
  }

  const tokenUrl = resolveOAuthTokenUrl(providerId, creds.instanceUrl);
  if (!tokenUrl) return { ok: false, error: `Unknown OAuth provider '${providerId}'.` };

  let res;
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
    return { ok: false, error: `Refresh request failed: ${e?.message || e}` };
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const desc = body.error_description ?? body.error ?? `HTTP ${res.status}`;
    return { ok: false, error: desc, reconnectRequired: body.error === "invalid_grant" };
  }

  const accessToken = body.access_token;
  if (!accessToken) return { ok: false, error: "Provider did not return access_token on refresh." };
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : undefined;
  const expiresAt = expiresIn !== undefined ? Date.now() + expiresIn * 1000 : undefined;
  // GitLab rotates the refresh token on every use — always persist whatever
  // the response sends, falling back to the old one if it sent none.
  const newRefreshToken = body.refresh_token ?? stored.refresh_token;

  const wrote = setProviderOAuthToken(dataDir, providerId, {
    access_token: accessToken,
    refresh_token: newRefreshToken,
    ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
  });
  if (!wrote) return { ok: false, error: "Could not persist refreshed token (missing encryption key)." };
  updateRemoteOauthExpiry(dataDir, providerId, expiresAt);

  return { ok: true, accessToken };
}

/**
 * resolveRemoteToken, refreshing the token first when it's missing or within
 * REFRESH_BUFFER_MS of expiry — mirrors src/lib/gitops/auth.ts's resolveAuth
 * preemptive-refresh check. A refresh failure here is NOT fatal: it logs a
 * warning and falls back to the (possibly still-valid) stale token, same as
 * the main app — a token merely near expiry usually still works, and
 * fetchOriginWithAuth's reactive retry is the real backstop for when it
 * doesn't. Throws only when `authType` requires a credential (oauth/token)
 * but none could be resolved at all — silently falling through to an
 * unauthenticated fetch there used to fail confusingly with "could not read
 * Username" instead of naming the real problem.
 */
export async function resolveRemoteTokenFresh(dataDir, remoteName, authType, provider) {
  if (!authType || authType === "ssh") return null;

  const current = resolveRemoteToken(dataDir, remoteName, authType, provider);
  if (authType !== "oauth") {
    if (!current) throw new Error(`No stored credential for remote "${remoteName}" (authType "token") — configure it in Settings → Git Remotes.`);
    return current;
  }

  const needsRefresh = !current || current.expiresAt === undefined || current.expiresAt - Date.now() < REFRESH_BUFFER_MS;
  if (!needsRefresh) return current;

  const refreshed = await refreshOAuthToken(dataDir, provider);
  if (refreshed.ok && refreshed.accessToken) {
    return { token: refreshed.accessToken };
  }
  if (!current) {
    throw new Error(`No usable OAuth credential for provider "${provider}" and refresh failed: ${refreshed.error}`);
  }
  slog("warn", "git-auth", `OAuth refresh failed for provider "${provider}" — using existing token: ${refreshed.error}`, { provider });
  return current;
}

/**
 * Run `git(args, cwd, env)` with `remote`'s credentials attached, refreshing
 * and retrying ONCE on an auth failure. Never swallows: every throw carries
 * the real git stderr plus what the refresh attempt did, so a genuinely bad
 * credential (revoked refresh token, misconfigured OAuth app) surfaces a
 * specific, actionable error instead of a generic "may be busy, retry".
 */
export async function fetchOriginWithAuth(dataDir, git, remote, args, cwd) {
  const tokenResult = await resolveRemoteTokenFresh(dataDir, remote.name, remote.authType, remote.provider);
  const cred = tokenResult ? buildGitCredential(dataDir, tokenResult.token) : { args: [], env: undefined };

  try {
    return await git([...cred.args, ...args], cwd, cred.env);
  } catch (firstErr) {
    const firstMsg = firstErr?.message || String(firstErr);
    if (!cred.env) throw firstErr; // no credential was ever supplied — nothing to refresh

    const refreshed = await refreshOAuthToken(dataDir, remote.provider);
    let freshToken;
    if (refreshed.ok && refreshed.accessToken) {
      freshToken = refreshed.accessToken;
    } else if (refreshed.reconnectRequired) {
      // invalid_grant (or no refresh_token on file) can mean a CONCURRENT
      // refresher elsewhere already rotated the refresh_token before we
      // could use it — GitLab rotates it on every use, and there's no
      // cross-process lock (matching this codebase's existing accepted risk
      // posture). Re-read the on-disk token fresh (no refresh) and trust it
      // ONLY if it's a genuinely different token than the one that just
      // failed — an expiresAt that merely looks future-dated isn't proof
      // GitLab will accept it.
      const reread = resolveRemoteToken(dataDir, remote.name, remote.authType, remote.provider);
      if (reread && reread.token !== tokenResult?.token) {
        freshToken = reread.token;
      } else {
        throw new Error(
          `${firstMsg}\n\n(after refresh attempt for provider "${remote.provider}": ${refreshed.error} — reconnect required in Settings → Git Providers)`,
        );
      }
    } else {
      throw new Error(`${firstMsg}\n\n(after refresh attempt for provider "${remote.provider}": ${refreshed.error})`);
    }

    const freshCred = buildGitCredential(dataDir, freshToken);
    try {
      return await git([...freshCred.args, ...args], cwd, freshCred.env);
    } catch (secondErr) {
      throw new Error(`${secondErr?.message || secondErr}\n\n(retried once after a successful OAuth refresh — this is a NEW failure, not the original)`);
    }
  }
}
