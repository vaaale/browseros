// OAuth Flow — E2E tests for GitHub and GitLab OAuth integration flows.
//
//   npx playwright test -c playwright.unit.config.ts tests/e2e/oauth-flow.spec.ts
//
// These tests exercise the full OAuth flow (start → callback → token storage)
// by simulating the OAuthManager logic with in-memory stores.  Provider
// manifests are imported directly (no server-only gate).  Token exchange
// HTTP calls are stubbed via a simulated fetch layer.

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
  createOAuthClient as getGitLabClient,
} from "../../src/lib/integrations/oauth/providers/gitlab";
import {
  OAUTH_PROVIDERS,
  getOAuthProvider,
} from "../../src/lib/integrations/oauth/providers";
import type { OAuthProviderManifest } from "../../src/lib/integrations/oauth/providers/github";
import type { OAuthTokens } from "../../src/lib/integrations/types";

// ── Simulated SecretsStore (in-memory) ─────────────────────────────────────

interface SecretEntry {
  namespace: string;
  key: string;
  value: unknown;
}

class SimSecretsStore {
  private secrets: SecretEntry[] = [];

  set(namespace: string, key: string, value: unknown): void {
    const idx = this.secrets.findIndex((s) => s.namespace === namespace && s.key === key);
    if (idx >= 0) this.secrets[idx].value = value;
    else this.secrets.push({ namespace, key, value });
  }

  get<T = unknown>(namespace: string, key: string): T | null {
    const entry = this.secrets.find((s) => s.namespace === namespace && s.key === key);
    return (entry?.value as T) ?? null;
  }

  delete(namespace: string, key: string): boolean {
    const idx = this.secrets.findIndex((s) => s.namespace === namespace && s.key === key);
    if (idx === -1) return false;
    this.secrets.splice(idx, 1);
    return true;
  }

  hasKey(namespace: string, key: string): boolean {
    return this.secrets.some((s) => s.namespace === namespace && s.key === key);
  }

  listKeys(namespace: string): string[] {
    return this.secrets
      .filter((s) => s.namespace === namespace)
      .map((s) => s.key);
  }

  reset(): void {
    this.secrets = [];
  }
}

// ── Simulated Pending OAuth Flow Store ──────────────────────────────────────

interface PendingFlow {
  integrationId: string;
  verifier: string;
  scopes: string[];
  createdAt: number;
  redirectUri: string;
}

class SimPendingStore {
  private flows = new Map<string, PendingFlow>();

  put(flow: PendingFlow): string {
    const state = `test-state-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.flows.set(state, { ...flow });
    return state;
  }

  take(state: string): PendingFlow | null {
    const flow = this.flows.get(state);
    if (!flow) return null;
    this.flows.delete(state);
    return flow;
  }

  reset(): void {
    this.flows.clear();
  }
}

// ── Simulated OAuth Flow Manager ────────────────────────────────────────────

interface StartFlowResult {
  state: string;
  authUrl: string;
}

interface CallbackResult {
  integrationId: string;
  grantedScopes: string[];
}

function simulateStartFlow(
  manifest: OAuthProviderManifest,
  clientId: string,
  clientSecret: string,
  scopes: string[],
  origin: string,
  secretsStore: SimSecretsStore,
  pendingStore: SimPendingStore,
): StartFlowResult {
  const redirectUri = `${origin.replace(/\/$/, "")}/api/integrations/oauth/callback`;

  // Store client secrets so callback can use them
  secretsStore.set("oauth_client", manifest.id, {
    clientId,
    clientSecret,
    redirectUris: [redirectUri],
  });

  const verifier = "sim-verifier-" + Math.random().toString(36).slice(2);
  const challenge = "sim-challenge-" + Math.random().toString(36).slice(2);
  const state = pendingStore.put({
    integrationId: manifest.id,
    verifier,
    scopes,
    createdAt: Date.now(),
    redirectUri,
  });

  const url = new URL(manifest.authUrl);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  return { state, authUrl: url.toString() };
}

function simulateHandleCallback(
  code: string,
  state: string,
  tokenResponse: { access_token: string; expires_in: number; scope?: string; refresh_token?: string } | null,
  secretsStore: SimSecretsStore,
  pendingStore: SimPendingStore,
): CallbackResult {
  const flow = pendingStore.take(state);
  if (!flow) {
    throw new Error("OAuth state expired or unknown. Please try connecting again.");
  }

  if (!tokenResponse) {
    throw new Error("Token exchange failed");
  }

  if (!tokenResponse.access_token || typeof tokenResponse.expires_in !== "number") {
    throw new Error("Provider did not return access_token/expires_in");
  }

  const grantedScopes = (tokenResponse.scope ?? flow.scopes.join(" ")).split(/\s+/).filter(Boolean);
  const tokens: OAuthTokens = {
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token ?? "",
    expires_at: Date.now() + tokenResponse.expires_in * 1000,
    granted_scopes: grantedScopes,
  };

  secretsStore.set(flow.integrationId, "tokens", tokens);

  return { integrationId: flow.integrationId, grantedScopes };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildCallbackUrl(code: string, state: string): string {
  return `http://localhost:3000/api/integrations/oauth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
}

function parseCallbackUrl(url: string): { code: string | null; state: string | null } {
  const parsed = new URL(url);
  return {
    code: parsed.searchParams.get("code"),
    state: parsed.searchParams.get("state"),
  };
}

// ── Shared state ────────────────────────────────────────────────────────────

let secretsStore: SimSecretsStore;
let pendingStore: SimPendingStore;

const GITHUB_CLIENT_ID = "test-github-client-id";
const GITHUB_CLIENT_SECRET = "test-github-client-secret";
const GITLAB_CLIENT_ID = "test-gitlab-client-id";
const GITLAB_CLIENT_SECRET = "test-gitlab-client-secret";
const ORIGIN = "http://localhost:3000";

test.beforeEach(() => {
  secretsStore = new SimSecretsStore();
  pendingStore = new SimPendingStore();
});

// ════════════════════════════════════════════════════════════════════════════
// 1. GitHub OAuth Flow
// ════════════════════════════════════════════════════════════════════════════

test.describe("GitHub OAuth flow", () => {
  test("startFlow returns a state token and auth URL pointing to github.com", () => {
    const result = simulateStartFlow(
      GITHUB_MANIFEST,
      GITHUB_CLIENT_ID,
      GITHUB_CLIENT_SECRET,
      GITHUB_MANIFEST.scopes,
      ORIGIN,
      secretsStore,
      pendingStore,
    );

    expect(result.state).toBeTruthy();
    expect(typeof result.state).toBe("string");

    const url = new URL(result.authUrl);
    expect(url.origin).toBe("https://github.com");
    expect(url.pathname).toBe("/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(GITHUB_CLIENT_ID);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(result.state);
    expect(url.searchParams.get("scope")).toBe(GITHUB_MANIFEST.scopes.join(" "));
  });

  test("callback with valid state succeeds and stores tokens", () => {
    const { state } = simulateStartFlow(
      GITHUB_MANIFEST,
      GITHUB_CLIENT_ID,
      GITHUB_CLIENT_SECRET,
      GITHUB_MANIFEST.scopes,
      ORIGIN,
      secretsStore,
      pendingStore,
    );

    const result = simulateHandleCallback(
      "gho_valid_code_123",
      state,
      { access_token: "gho_test_token_xyz", expires_in: 3600, scope: "read:user repo" },
      secretsStore,
      pendingStore,
    );

    expect(result.integrationId).toBe("github");
    expect(result.grantedScopes).toEqual(["read:user", "repo"]);

    // Verify token persisted in SecretsStore
    const stored = secretsStore.get<OAuthTokens>("github", "tokens");
    expect(stored).not.toBeNull();
    expect(stored!.access_token).toBe("gho_test_token_xyz");
    expect(stored!.expires_at).toBeGreaterThan(Date.now());
    expect(stored!.granted_scopes).toEqual(["read:user", "repo"]);
  });

  test("callback with invalid state rejects", () => {
    expect(() =>
      simulateHandleCallback(
        "code",
        "invalid-state-123",
        { access_token: "tok", expires_in: 3600 },
        secretsStore,
        pendingStore,
      ),
    ).toThrow("OAuth state expired or unknown");
  });

  test("callback with expired/reused state rejects", () => {
    const { state } = simulateStartFlow(
      GITHUB_MANIFEST,
      GITHUB_CLIENT_ID,
      GITHUB_CLIENT_SECRET,
      GITHUB_MANIFEST.scopes,
      ORIGIN,
      secretsStore,
      pendingStore,
    );

    // First use succeeds
    simulateHandleCallback(
      "code",
      state,
      { access_token: "tok1", expires_in: 3600 },
      secretsStore,
      pendingStore,
    );

    // Second use with same state fails (state consumed)
    expect(() =>
      simulateHandleCallback(
        "code",
        state,
        { access_token: "tok2", expires_in: 3600 },
        secretsStore,
        pendingStore,
      ),
    ).toThrow("OAuth state expired or unknown");
  });

  test("token stored correctly with refresh_token", () => {
    const { state } = simulateStartFlow(
      GITHUB_MANIFEST,
      GITHUB_CLIENT_ID,
      GITHUB_CLIENT_SECRET,
      GITHUB_MANIFEST.scopes,
      ORIGIN,
      secretsStore,
      pendingStore,
    );

    simulateHandleCallback(
      "code",
      state,
      { access_token: "gho_with_refresh", expires_in: 7200, refresh_token: "ghr_refresh_abc", scope: "repo" },
      secretsStore,
      pendingStore,
    );

    const stored = secretsStore.get<OAuthTokens>("github", "tokens");
    expect(stored!.access_token).toBe("gho_with_refresh");
    expect(stored!.refresh_token).toBe("ghr_refresh_abc");
    expect(stored!.granted_scopes).toEqual(["repo"]);
  });

  test("callback URL is correct", () => {
    const url = buildCallbackUrl("test-code", "test-state");
    expect(url).toContain("/api/integrations/oauth/callback");
    expect(url).toContain("code=test-code");
    expect(url).toContain("state=test-state");

    const parsed = parseCallbackUrl(url);
    expect(parsed.code).toBe("test-code");
    expect(parsed.state).toBe("test-state");
  });

  test("redirect URI in auth URL points to correct callback", () => {
    const result = simulateStartFlow(
      GITHUB_MANIFEST,
      GITHUB_CLIENT_ID,
      GITHUB_CLIENT_SECRET,
      GITHUB_MANIFEST.scopes,
      ORIGIN,
      secretsStore,
      pendingStore,
    );

    const url = new URL(result.authUrl);
    const redirectUri = url.searchParams.get("redirect_uri");
    expect(redirectUri).toBe("http://localhost:3000/api/integrations/oauth/callback");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. GitLab OAuth Flow
// ════════════════════════════════════════════════════════════════════════════

test.describe("GitLab OAuth flow", () => {
  test("startFlow returns a state token and auth URL pointing to gitlab.com", () => {
    const result = simulateStartFlow(
      GITLAB_MANIFEST,
      GITLAB_CLIENT_ID,
      GITLAB_CLIENT_SECRET,
      GITLAB_MANIFEST.scopes,
      ORIGIN,
      secretsStore,
      pendingStore,
    );

    expect(result.state).toBeTruthy();
    expect(typeof result.state).toBe("string");

    const url = new URL(result.authUrl);
    expect(url.origin).toBe("https://gitlab.com");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(GITLAB_CLIENT_ID);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(result.state);
    expect(url.searchParams.get("scope")).toBe(GITLAB_MANIFEST.scopes.join(" "));
  });

  test("callback with valid state succeeds and stores tokens", () => {
    const { state } = simulateStartFlow(
      GITLAB_MANIFEST,
      GITLAB_CLIENT_ID,
      GITLAB_CLIENT_SECRET,
      GITLAB_MANIFEST.scopes,
      ORIGIN,
      secretsStore,
      pendingStore,
    );

    const result = simulateHandleCallback(
      "glpat_valid_code_456",
      state,
      { access_token: "glpat_test_token_abc", expires_in: 7200, scope: "api read_user" },
      secretsStore,
      pendingStore,
    );

    expect(result.integrationId).toBe("gitlab");
    expect(result.grantedScopes).toEqual(["api", "read_user"]);

    // Verify token persisted in SecretsStore
    const stored = secretsStore.get<OAuthTokens>("gitlab", "tokens");
    expect(stored).not.toBeNull();
    expect(stored!.access_token).toBe("glpat_test_token_abc");
    expect(stored!.expires_at).toBeGreaterThan(Date.now());
    expect(stored!.granted_scopes).toEqual(["api", "read_user"]);
  });

  test("callback with invalid state rejects", () => {
    expect(() =>
      simulateHandleCallback(
        "code",
        "nonexistent-state",
        { access_token: "tok", expires_in: 3600 },
        secretsStore,
        pendingStore,
      ),
    ).toThrow("OAuth state expired or unknown");
  });

  test("token stored correctly with all fields", () => {
    const { state } = simulateStartFlow(
      GITLAB_MANIFEST,
      GITLAB_CLIENT_ID,
      GITLAB_CLIENT_SECRET,
      GITLAB_MANIFEST.scopes,
      ORIGIN,
      secretsStore,
      pendingStore,
    );

    simulateHandleCallback(
      "code",
      state,
      {
        access_token: "glpat_full_token",
        expires_in: 3600,
        scope: "api read_user read_repository write_repository",
        refresh_token: "glrt_refresh_xyz",
      },
      secretsStore,
      pendingStore,
    );

    const stored = secretsStore.get<OAuthTokens>("gitlab", "tokens");
    expect(stored!.access_token).toBe("glpat_full_token");
    expect(stored!.refresh_token).toBe("glrt_refresh_xyz");
    expect(stored!.granted_scopes).toEqual(["api", "read_user", "read_repository", "write_repository"]);
  });

  test("missing scope in token response falls back to requested scopes", () => {
    const { state } = simulateStartFlow(
      GITLAB_MANIFEST,
      GITLAB_CLIENT_ID,
      GITLAB_CLIENT_SECRET,
      ["api", "read_user"],
      ORIGIN,
      secretsStore,
      pendingStore,
    );

    const result = simulateHandleCallback(
      "code",
      state,
      { access_token: "tok", expires_in: 3600 },
      secretsStore,
      pendingStore,
    );

    expect(result.grantedScopes).toEqual(["api", "read_user"]);
  });

  test("redirect URI in auth URL points to correct callback", () => {
    const result = simulateStartFlow(
      GITLAB_MANIFEST,
      GITLAB_CLIENT_ID,
      GITLAB_CLIENT_SECRET,
      GITLAB_MANIFEST.scopes,
      ORIGIN,
      secretsStore,
      pendingStore,
    );

    const url = new URL(result.authUrl);
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/integrations/oauth/callback");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Provider integration — shared contract tests
// ════════════════════════════════════════════════════════════════════════════

test.describe("OAuth provider contracts", () => {
  test("both providers use correct scopes", () => {
    expect(GITHUB_MANIFEST.scopes).toContain("read:user");
    expect(GITHUB_MANIFEST.scopes).toContain("user:email");
    expect(GITHUB_MANIFEST.scopes).toContain("repo");

    expect(GITLAB_MANIFEST.scopes).toContain("api");
    expect(GITLAB_MANIFEST.scopes).toContain("read_user");
    expect(GITLAB_MANIFEST.scopes).toContain("read_repository");
    expect(GITLAB_MANIFEST.scopes).toContain("write_repository");
  });

  test("both providers use correct token URLs", () => {
    expect(GITHUB_MANIFEST.tokenUrl).toBe("https://github.com/login/oauth/access_token");
    expect(GITLAB_MANIFEST.tokenUrl).toBe("https://gitlab.com/oauth/token");
  });

  test("both providers use correct auth URLs", () => {
    expect(GITHUB_MANIFEST.authUrl).toBe("https://github.com/login/oauth/authorize");
    expect(GITLAB_MANIFEST.authUrl).toBe("https://gitlab.com/oauth/authorize");
  });

  test("both providers return correct icon", () => {
    expect(GITHUB_MANIFEST.icon).toBe("Github");
    expect(GITLAB_MANIFEST.icon).toBe("GitBranch");
  });

  test("OAUTH_PROVIDERS barrel includes both providers", () => {
    expect(OAUTH_PROVIDERS).toHaveLength(2);
    const ids = OAUTH_PROVIDERS.map((p) => p.id);
    expect(ids).toContain("github");
    expect(ids).toContain("gitlab");
  });

  test("getOAuthProvider returns correct manifest by id", () => {
    expect(getOAuthProvider("github")).toBe(GITHUB_MANIFEST);
    expect(getOAuthProvider("gitlab")).toBe(GITLAB_MANIFEST);
    expect(getOAuthProvider("unknown")).toBeUndefined();
  });

  test("both providers have required manifest fields", () => {
    for (const manifest of [GITHUB_MANIFEST, GITLAB_MANIFEST]) {
      expect(manifest.id).toBeTruthy();
      expect(manifest.name).toBeTruthy();
      expect(manifest.authUrl).toMatch(/^https?:\/\//);
      expect(manifest.tokenUrl).toMatch(/^https?:\/\//);
      expect(manifest.scopes.length).toBeGreaterThan(0);
      expect(manifest.icon).toBeTruthy();
      expect(manifest.description).toBeTruthy();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. State uniqueness and URL encoding
// ════════════════════════════════════════════════════════════════════════════

test.describe("OAuth state generation", () => {
  test("consecutive GitHub states are unique", () => {
    const states = new Set(Array.from({ length: 20 }, () => getGitHubState()));
    expect(states.size).toBe(20);
  });

  test("consecutive GitLab states are unique", () => {
    const states = new Set(Array.from({ length: 20 }, () => getGitLabState()));
    expect(states.size).toBe(20);
  });

  test("callback URL encodes special characters in state", () => {
    const specialState = "abc+def/ghi=";
    const url = createGitHubCallbackUrl(specialState);
    expect(url).toContain(encodeURIComponent(specialState));
    expect(url).not.toContain("+");
  });

  test("callback URL starts with correct path", () => {
    const ghUrl = createGitHubCallbackUrl("x");
    const glUrl = createGitLabCallbackUrl("x");
    expect(ghUrl).toMatch(/^\/api\/integrations\/oauth\/callback\?/);
    expect(glUrl).toMatch(/^\/api\/integrations\/oauth\/callback\?/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. End-to-end OAuth lifecycle
// ════════════════════════════════════════════════════════════════════════════

test.describe("End-to-end OAuth lifecycle", () => {
  test("GitHub: start flow → callback → verify token in store", () => {
    // Start
    const { state, authUrl } = simulateStartFlow(
      GITHUB_MANIFEST,
      GITHUB_CLIENT_ID,
      GITHUB_CLIENT_SECRET,
      ["read:user", "repo"],
      ORIGIN,
      secretsStore,
      pendingStore,
    );
    expect(authUrl).toContain("github.com");
    expect(authUrl).toContain("client_id=" + GITHUB_CLIENT_ID);

    // Callback
    const { grantedScopes } = simulateHandleCallback(
      "auth-code-gh",
      state,
      { access_token: "gho_lifecycle_tok", expires_in: 3600, scope: "read:user repo" },
      secretsStore,
      pendingStore,
    );
    expect(grantedScopes).toEqual(["read:user", "repo"]);

    // Verify store
    const stored = secretsStore.get<OAuthTokens>("github", "tokens");
    expect(stored!.access_token).toBe("gho_lifecycle_tok");
    expect(stored!.expires_at).toBeGreaterThan(Date.now());
  });

  test("GitLab: start flow → callback → verify token in store", () => {
    // Start
    const { state, authUrl } = simulateStartFlow(
      GITLAB_MANIFEST,
      GITLAB_CLIENT_ID,
      GITLAB_CLIENT_SECRET,
      ["api", "read_user"],
      ORIGIN,
      secretsStore,
      pendingStore,
    );
    expect(authUrl).toContain("gitlab.com");
    expect(authUrl).toContain("client_id=" + GITLAB_CLIENT_ID);

    // Callback
    const { grantedScopes } = simulateHandleCallback(
      "auth-code-gl",
      state,
      { access_token: "glpat_lifecycle_tok", expires_in: 7200, scope: "api read_user" },
      secretsStore,
      pendingStore,
    );
    expect(grantedScopes).toEqual(["api", "read_user"]);

    // Verify store
    const stored = secretsStore.get<OAuthTokens>("gitlab", "tokens");
    expect(stored!.access_token).toBe("glpat_lifecycle_tok");
    expect(stored!.expires_at).toBeGreaterThan(Date.now());
  });

  test("concurrent flows for different providers are isolated", () => {
    const ghFlow = simulateStartFlow(
      GITHUB_MANIFEST,
      GITHUB_CLIENT_ID,
      GITHUB_CLIENT_SECRET,
      ["repo"],
      ORIGIN,
      secretsStore,
      pendingStore,
    );
    const glFlow = simulateStartFlow(
      GITLAB_MANIFEST,
      GITLAB_CLIENT_ID,
      GITLAB_CLIENT_SECRET,
      ["api"],
      ORIGIN,
      secretsStore,
      pendingStore,
    );

    // Both states are distinct
    expect(ghFlow.state).not.toBe(glFlow.state);

    // Complete each independently
    const ghResult = simulateHandleCallback(
      "code-gh",
      ghFlow.state,
      { access_token: "gho_concurrent", expires_in: 3600, scope: "repo" },
      secretsStore,
      pendingStore,
    );
    const glResult = simulateHandleCallback(
      "code-gl",
      glFlow.state,
      { access_token: "glpat_concurrent", expires_in: 7200, scope: "api" },
      secretsStore,
      pendingStore,
    );

    expect(ghResult.integrationId).toBe("github");
    expect(glResult.integrationId).toBe("gitlab");

    // Each stored in its own namespace
    const ghStored = secretsStore.get<OAuthTokens>("github", "tokens");
    const glStored = secretsStore.get<OAuthTokens>("gitlab", "tokens");
    expect(ghStored!.access_token).toBe("gho_concurrent");
    expect(glStored!.access_token).toBe("glpat_concurrent");
  });

  test("token exchange error from provider is handled", () => {
    const { state } = simulateStartFlow(
      GITHUB_MANIFEST,
      GITHUB_CLIENT_ID,
      GITHUB_CLIENT_SECRET,
      ["repo"],
      ORIGIN,
      secretsStore,
      pendingStore,
    );

    expect(() =>
      simulateHandleCallback(
        "code",
        state,
        null,
        secretsStore,
        pendingStore,
      ),
    ).toThrow("Token exchange failed");
  });

  test("missing access_token in response is rejected", () => {
    const { state } = simulateStartFlow(
      GITLAB_MANIFEST,
      GITLAB_CLIENT_ID,
      GITLAB_CLIENT_SECRET,
      ["api"],
      ORIGIN,
      secretsStore,
      pendingStore,
    );

    expect(() =>
      simulateHandleCallback(
        "code",
        state,
        { access_token: "", expires_in: 3600 },
        secretsStore,
        pendingStore,
      ),
    ).toThrow("did not return access_token");
  });
});
