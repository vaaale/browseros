import "server-only";
import { getIntegration } from "../registry";
import { getSecretsStore } from "../secrets/store";
import { mutateState, readState } from "../state/store";
import { challengeFromVerifier, newVerifier } from "./pkce";
import { putPending, takePending } from "./state";
import type { OAuthTokens } from "../types";
import { IntegrationAuthError, IntegrationConfigError } from "../errors";

// OAuthManager — one instance per process. Implements the PKCE authorisation-
// code flow: build the auth URL from the manifest + user-uploaded client
// credentials, exchange the code on callback, persist tokens to SecretsStore,
// and refresh transparently near expiry.
//
// Client credentials live in SecretsStore under `oauth_client:<integrationId>`
// (see plan §2.1). The shape stored there is `NormalizedClientSecrets` (below):
// integration-specific uploaders (e.g. gsuite/client-secrets.ts) parse the
// vendor's JSON and write this canonical shape.

export interface NormalizedClientSecrets {
  clientId: string;
  clientSecret: string;
  /** Full list from the file; the manager picks the first exact match with the
   *  configured redirect URI. */
  redirectUris: string[];
  authUri: string;
  tokenUri: string;
}

export interface StartFlowInput {
  integrationId: string;
  /** Optional override for the scopes to request. Defaults to the manifest's
   *  full supportedScopes list. */
  scopes?: string[];
  /** Origin (protocol + host + port) that hosts the callback route. Falls
   *  back to NEXT_PUBLIC_APP_ORIGIN or http://localhost:3000. */
  origin?: string;
}

export interface StartFlowResult {
  authUrl: string;
}

interface RefreshResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
}

function computeRedirectUri(origin?: string): string {
  const base = origin ?? process.env.NEXT_PUBLIC_APP_ORIGIN ?? "http://localhost:3000";
  return `${base.replace(/\/$/, "")}/api/integrations/oauth/callback`;
}

function ensureClientSecrets(integrationId: string, cs: NormalizedClientSecrets | null): NormalizedClientSecrets {
  if (!cs) {
    throw new IntegrationConfigError(
      `No client_secrets.json uploaded for ${integrationId}. Upload it in Settings → Integrations.`,
      { integrationId },
    );
  }
  return cs;
}

async function loadClientSecrets(integrationId: string): Promise<NormalizedClientSecrets | null> {
  return getSecretsStore().get<NormalizedClientSecrets>(integrationId, "oauth_client");
}

async function loadTokens(integrationId: string): Promise<OAuthTokens | null> {
  return getSecretsStore().get<OAuthTokens>(integrationId, "tokens");
}

async function saveTokens(integrationId: string, tokens: OAuthTokens): Promise<void> {
  await getSecretsStore().set(integrationId, "tokens", tokens);
}

export class OAuthManager {
  /** In-flight refresh promises keyed by integrationId so parallel callers
   *  share one round-trip. */
  private inflight = new Map<string, Promise<OAuthTokens>>();

  async startFlow(input: StartFlowInput): Promise<StartFlowResult> {
    const manifest = getIntegration(input.integrationId);
    if (!manifest) {
      throw new IntegrationConfigError(`Unknown integration: ${input.integrationId}`, { integrationId: input.integrationId });
    }
    const cs = ensureClientSecrets(input.integrationId, await loadClientSecrets(input.integrationId));
    const scopes = input.scopes && input.scopes.length > 0 ? input.scopes : manifest.oauthConfig.supportedScopes;
    const verifier = newVerifier();
    const challenge = challengeFromVerifier(verifier);
    const state = putPending({ integrationId: input.integrationId, verifier, scopes });
    const redirectUri = computeRedirectUri(input.origin);

    const url = new URL(manifest.oauthConfig.authorizationUrl);
    url.searchParams.set("client_id", cs.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", scopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    // Google-specific but harmless on other providers.
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");

    return { authUrl: url.toString() };
  }

  /**
   * Finalise a PKCE flow. Called by the callback route with the code + state
   * from the provider redirect. Returns the granted scopes so the caller can
   * render the consent summary.
   */
  async handleCallback(input: { code: string; state: string; origin?: string }): Promise<{
    integrationId: string;
    grantedScopes: string[];
  }> {
    const flow = takePending(input.state);
    if (!flow) {
      throw new IntegrationAuthError("OAuth state expired or unknown. Please try connecting again.");
    }
    const manifest = getIntegration(flow.integrationId);
    if (!manifest) {
      throw new IntegrationConfigError(`Unknown integration: ${flow.integrationId}`, { integrationId: flow.integrationId });
    }
    const cs = ensureClientSecrets(flow.integrationId, await loadClientSecrets(flow.integrationId));
    const redirectUri = computeRedirectUri(input.origin);

    let res: Response;
    let body: unknown;
    try {
      res = await fetch(manifest.oauthConfig.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: input.code,
          redirect_uri: redirectUri,
          client_id: cs.clientId,
          client_secret: cs.clientSecret,
          code_verifier: flow.verifier,
        }).toString(),
      });
      body = await res.json().catch(() => ({}));
    } catch (err) {
      await this.markError(flow.integrationId, (err as Error).message);
      throw new IntegrationAuthError(`Token exchange failed: ${(err as Error).message}`, { integrationId: flow.integrationId, cause: err });
    }
    if (!res.ok) {
      const desc = (body as { error_description?: string; error?: string })?.error_description ?? (body as { error?: string })?.error ?? `HTTP ${res.status}`;
      await this.markError(flow.integrationId, desc);
      throw new IntegrationAuthError(`Token exchange rejected: ${desc}`, { integrationId: flow.integrationId });
    }

    const payload = body as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    if (!payload.access_token || typeof payload.expires_in !== "number") {
      await this.markError(flow.integrationId, "provider omitted access_token/expires_in");
      throw new IntegrationAuthError("Provider did not return access_token/expires_in", { integrationId: flow.integrationId });
    }
    const grantedScopes = (payload.scope ?? flow.scopes.join(" ")).split(/\s+/).filter(Boolean);
    const tokens: OAuthTokens = {
      access_token: payload.access_token,
      refresh_token: payload.refresh_token ?? (await loadTokens(flow.integrationId))?.refresh_token ?? "",
      expires_at: Date.now() + payload.expires_in * 1000,
      granted_scopes: grantedScopes,
    };
    await saveTokens(flow.integrationId, tokens);
    await mutateState(flow.integrationId, (prev) => ({
      ...prev,
      connected: true,
      lastConnected: Date.now(),
      oauthMeta: { expires_at: tokens.expires_at, granted_scopes: tokens.granted_scopes },
      lastError: undefined,
    }));
    return { integrationId: flow.integrationId, grantedScopes };
  }

  /** Return an access token that is valid for at least the next 60 seconds. */
  async getValidToken(integrationId: string): Promise<string> {
    const existing = await loadTokens(integrationId);
    if (!existing) {
      throw new IntegrationAuthError(`${integrationId} is not connected`, { integrationId });
    }
    if (existing.expires_at - Date.now() > 60_000) {
      return existing.access_token;
    }
    return (await this.refreshToken(integrationId, existing)).access_token;
  }

  async refreshToken(integrationId: string, current?: OAuthTokens): Promise<OAuthTokens> {
    const existing = current ?? (await loadTokens(integrationId));
    if (!existing) throw new IntegrationAuthError(`${integrationId} is not connected`, { integrationId });
    if (!existing.refresh_token) {
      throw new IntegrationAuthError(`${integrationId} has no refresh_token; please reconnect`, { integrationId });
    }
    const inflight = this.inflight.get(integrationId);
    if (inflight) return inflight;

    const p = (async (): Promise<OAuthTokens> => {
      const manifest = getIntegration(integrationId);
      if (!manifest) throw new IntegrationConfigError(`Unknown integration: ${integrationId}`, { integrationId });
      const cs = ensureClientSecrets(integrationId, await loadClientSecrets(integrationId));
      const res = await fetch(manifest.oauthConfig.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: existing.refresh_token,
          client_id: cs.clientId,
          client_secret: cs.clientSecret,
        }).toString(),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<RefreshResponse> & { error?: string; error_description?: string };
      if (!res.ok || !body.access_token || typeof body.expires_in !== "number") {
        const desc = body.error_description ?? body.error ?? `HTTP ${res.status}`;
        if (body.error === "invalid_grant") {
          await getSecretsStore().delete(integrationId, "tokens");
          await mutateState(integrationId, (prev) => ({ ...prev, connected: false, oauthMeta: undefined, lastError: `refresh failed: ${desc}` }));
        } else {
          await this.markError(integrationId, desc);
        }
        throw new IntegrationAuthError(`Refresh failed for ${integrationId}: ${desc}`, { integrationId });
      }
      const grantedScopes = body.scope ? body.scope.split(/\s+/).filter(Boolean) : existing.granted_scopes;
      const next: OAuthTokens = {
        access_token: body.access_token,
        refresh_token: body.refresh_token ?? existing.refresh_token,
        expires_at: Date.now() + body.expires_in * 1000,
        granted_scopes: grantedScopes,
      };
      await saveTokens(integrationId, next);
      await mutateState(integrationId, (prev) => ({
        ...prev,
        connected: true,
        oauthMeta: { expires_at: next.expires_at, granted_scopes: next.granted_scopes },
        lastError: undefined,
      }));
      return next;
    })().finally(() => {
      this.inflight.delete(integrationId);
    });
    this.inflight.set(integrationId, p);
    return p;
  }

  private async markError(integrationId: string, message: string): Promise<void> {
    await mutateState(integrationId, (prev) => ({ ...prev, lastError: message })).catch(() => {});
  }
}

let singleton: OAuthManager | undefined;

export function getOAuthManager(): OAuthManager {
  if (!singleton) singleton = new OAuthManager();
  return singleton;
}
