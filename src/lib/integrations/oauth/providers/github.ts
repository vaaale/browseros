import { randomBytes } from "crypto";

export interface OAuthProviderManifest {
  id: string;
  name: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  icon: string;
  description: string;
}

export interface OAuthClient {
  exchangeCode(code: string): Promise<{
    access_token: string;
    token_type: string;
    scope: string;
  }>;
}

export const GITHUB_MANIFEST: OAuthProviderManifest = {
  id: "github",
  name: "GitHub",
  authUrl: "https://github.com/login/oauth/authorize",
  tokenUrl: "https://github.com/login/oauth/access_token",
  scopes: ["read:user", "user:email", "repo"],
  icon: "Github",
  description: "GitHub — user profile, email, and repository access.",
};

export function createOAuthClient(
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  scopes: string[],
): OAuthClient {
  return {
    async exchangeCode(code: string) {
      const res = await fetch(GITHUB_MANIFEST.tokenUrl, {
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
        throw new Error(`GitHub token exchange failed: HTTP ${res.status}`);
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
