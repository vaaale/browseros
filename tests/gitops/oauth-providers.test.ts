// OAuth provider unit tests
//   npx playwright test -c playwright.unit.config.ts tests/gitops/oauth-providers.test.ts

import { test, expect } from "@playwright/test";
import {
  GITHUB_MANIFEST,
  getOAuthState as getGitHubState,
  createOAuthCallbackUrl as createGitHubCallbackUrl,
  createOAuthClient as createGitHubClient,
} from "../../src/lib/integrations/oauth/providers/github";
import {
  GITLAB_MANIFEST,
  getOAuthState as getGitLabState,
  createOAuthCallbackUrl as createGitLabCallbackUrl,
  createOAuthClient as createGitLabClient,
} from "../../src/lib/integrations/oauth/providers/gitlab";
import {
  OAUTH_PROVIDERS,
  getOAuthProvider,
} from "../../src/lib/integrations/oauth/providers";
import type { OAuthProviderManifest } from "../../src/lib/integrations/oauth/providers/github";

// ── Helpers ──────────────────────────────────────────────────────────────

function validateManifest(m: OAuthProviderManifest, expectedId: string): void {
  expect(m.id).toBe(expectedId);
  expect(m.name).toBeTruthy();
  expect(m.authUrl).toMatch(/^https?:\/\//);
  expect(m.tokenUrl).toMatch(/^https?:\/\//);
  expect(Array.isArray(m.scopes)).toBe(true);
  expect(m.scopes.length).toBeGreaterThan(0);
  expect(m.icon).toBeTruthy();
  expect(m.description).toBeTruthy();
}

// ── Manifest structure ───────────────────────────────────────────────────

test.describe("OAuth provider manifests", () => {
  test("GitHub manifest has all required fields", () => {
    validateManifest(GITHUB_MANIFEST, "github");
  });

  test("GitLab manifest has all required fields", () => {
    validateManifest(GITLAB_MANIFEST, "gitlab");
  });

  test("GitHub auth URL points to github.com", () => {
    expect(GITHUB_MANIFEST.authUrl).toContain("github.com");
  });

  test("GitHub token URL points to github.com", () => {
    expect(GITHUB_MANIFEST.tokenUrl).toContain("github.com");
  });

  test("GitLab auth URL points to gitlab.com", () => {
    expect(GITLAB_MANIFEST.authUrl).toContain("gitlab.com");
  });

  test("GitLab token URL points to gitlab.com", () => {
    expect(GITLAB_MANIFEST.tokenUrl).toContain("gitlab.com");
  });

  test("OAUTH_PROVIDERS barrel contains both providers", () => {
    expect(OAUTH_PROVIDERS).toHaveLength(2);
    const ids = OAUTH_PROVIDERS.map((p) => p.id);
    expect(ids).toContain("github");
    expect(ids).toContain("gitlab");
  });

  test("getOAuthProvider returns GitHub by id", () => {
    const p = getOAuthProvider("github");
    expect(p).toBeDefined();
    expect(p!.id).toBe("github");
  });

  test("getOAuthProvider returns GitLab by id", () => {
    const p = getOAuthProvider("gitlab");
    expect(p).toBeDefined();
    expect(p!.id).toBe("gitlab");
  });

  test("getOAuthProvider returns undefined for unknown id", () => {
    expect(getOAuthProvider("nonexistent")).toBeUndefined();
  });
});

// ── State generation ─────────────────────────────────────────────────────

test.describe("OAuth state generation", () => {
  test("GitHub getOAuthState returns a non-empty string", () => {
    const state = getGitHubState();
    expect(typeof state).toBe("string");
    expect(state.length).toBeGreaterThan(0);
  });

  test("GitLab getOAuthState returns a non-empty string", () => {
    const state = getGitLabState();
    expect(typeof state).toBe("string");
    expect(state.length).toBeGreaterThan(0);
  });

  test("consecutive GitHub states are unique", () => {
    const states = new Set(Array.from({ length: 10 }, () => getGitHubState()));
    expect(states.size).toBe(10);
  });

  test("consecutive GitLab states are unique", () => {
    const states = new Set(Array.from({ length: 10 }, () => getGitLabState()));
    expect(states.size).toBe(10);
  });

  test("GitHub and GitLab states are distinct generators", () => {
    const ghState = getGitHubState();
    const glState = getGitLabState();
    expect(ghState).not.toBe(glState);
  });
});

// ── Callback URL creation ────────────────────────────────────────────────

test.describe("OAuth callback URL creation", () => {
  test("GitHub callback URL contains the state parameter", () => {
    const url = createGitHubCallbackUrl("test-state-123");
    expect(url).toContain("state=test-state-123");
  });

  test("GitHub callback URL starts with the callback path", () => {
    const url = createGitHubCallbackUrl("abc");
    expect(url).toMatch(/^\/api\/integrations\/oauth\/callback\?/);
  });

  test("GitLab callback URL contains the state parameter", () => {
    const url = createGitLabCallbackUrl("test-state-456");
    expect(url).toContain("state=test-state-456");
  });

  test("GitLab callback URL starts with the callback path", () => {
    const url = createGitLabCallbackUrl("xyz");
    expect(url).toMatch(/^\/api\/integrations\/oauth\/callback\?/);
  });

  test("callback URL encodes special characters in state", () => {
    const specialState = "abc+def/ghi=";
    const url = createGitHubCallbackUrl(specialState);
    expect(url).toContain(encodeURIComponent(specialState));
    expect(url).not.toContain("+");
  });
});

// ── Client configuration ─────────────────────────────────────────────────

test.describe("OAuth client configuration", () => {
  test("GitHub createOAuthClient returns an object with exchangeCode", () => {
    const client = createGitHubClient("id", "secret", "http://localhost/callback", ["read:user"]);
    expect(client).toBeDefined();
    expect(typeof client.exchangeCode).toBe("function");
  });

  test("GitLab createOAuthClient returns an object with exchangeCode", () => {
    const client = createGitLabClient("id", "secret", "http://localhost/callback", ["api"]);
    expect(client).toBeDefined();
    expect(typeof client.exchangeCode).toBe("function");
  });

  // These two assert only that a failed exchange REJECTS rather than hanging
  // or resolving. They do not reach github.com/gitlab.com: the unit suite's
  // network guard (tests/_no-external-network.cjs) refuses non-loopback
  // egress, so the failure is a blocked connection, deterministically and
  // instantly. Until that guard existed they really did POST a fake code to
  // the live provider and depended on how it answered — which is a
  // network-availability test, not a unit test. Provider-side error handling
  // (a 401 with an `error` body) needs a stub server and is not covered here.
  test("GitHub client exchangeCode rejects on network error", async () => {
    const client = createGitHubClient("id", "secret", "http://localhost/callback", ["read:user"]);
    await expect(client.exchangeCode("fake-code")).rejects.toThrow();
  });

  test("GitLab client exchangeCode rejects on network error", async () => {
    const client = createGitLabClient("id", "secret", "http://localhost/callback", ["api"]);
    await expect(client.exchangeCode("fake-code")).rejects.toThrow();
  });
});
