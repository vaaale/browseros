import type { OAuthProviderManifest } from "./github";
import { GITHUB_MANIFEST } from "./github";
import { GITLAB_MANIFEST } from "./gitlab";

export { GITHUB_MANIFEST, getOAuthState as getGitHubOAuthState, createOAuthCallbackUrl as createGitHubOAuthCallbackUrl, createOAuthClient as createGitHubOAuthClient } from "./github";
export { GITLAB_MANIFEST, getOAuthState as getGitLabOAuthState, createOAuthCallbackUrl as createGitLabOAuthCallbackUrl, createOAuthClient as createGitLabOAuthClient } from "./gitlab";

export const OAUTH_PROVIDERS: OAuthProviderManifest[] = [
  GITHUB_MANIFEST,
  GITLAB_MANIFEST,
];

export function getOAuthProvider(id: string): OAuthProviderManifest | undefined {
  return OAUTH_PROVIDERS.find((p) => p.id === id);
}
