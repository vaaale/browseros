import { randomBytes } from "crypto";
import type { OAuthProviderManifest, OAuthClient } from "./github";

export const GITLAB_MANIFEST: OAuthProviderManifest = {
  id: "gitlab",
  name: "GitLab",
  authUrl: "https://gitlab.com/oauth/authorize",
  tokenUrl: "https://gitlab.com/oauth/token",
  scopes: ["api", "read_user", "read_repository", "write_repository"],
  icon: "GitBranch",
  description: "GitLab — user profile, repositories, and API access.",
};

export function createOAuthClient(
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  scopes: string[],
): OAuthClient {
  return {
    async exchangeCode(code: string) {
      const res = await fetch(GITLAB_MANIFEST.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
          scope: scopes.join(" "),
        }),
      });
      if (!res.ok) {
        throw new Error(`GitLab token exchange failed: HTTP ${res.status}`);
      }
      return res.json() as Promise<{
        access_token: string;
        token_type: string;
        scope: string;
      }>;
    },
  };
}

export function getOAuthState(): string {
  return randomBytes(24).toString("base64url");
}

export function createOAuthCallbackUrl(state: string): string {
  return `/api/integrations/oauth/callback?state=${encodeURIComponent(state)}`;
}
