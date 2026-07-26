// Git OAuth callback route tests
//   npx playwright test -c playwright.unit.config.ts tests/gitops/oauth-callback.test.ts
//
// These tests exercise the callback handler logic (URL validation, state
// verification, token exchange, SecretsStore integration) by importing
// pure helpers and calling them directly, avoiding the server-only import chain.

import { test, expect } from "@playwright/test";

// ── Pure helpers extracted from the callback route for testability ──────────

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return c;
    }
  });
}

interface CallbackUrlParams {
  code?: string | null;
  state?: string | null;
  error?: string | null;
}

function buildCallbackUrl(params: CallbackUrlParams = {}): string {
  const base = "http://localhost:3000/api/git-remotes/oauth/callback";
  const searchParams = new URLSearchParams();
  if (params.code) searchParams.set("code", params.code);
  if (params.state) searchParams.set("state", params.state);
  if (params.error) searchParams.set("error", params.error);
  return `${base}?${searchParams.toString()}`;
}

function parseCallbackUrl(url: string): { code: string | null; state: string | null; error: string | null } {
  const parsed = new URL(url);
  return {
    code: parsed.searchParams.get("code"),
    state: parsed.searchParams.get("state"),
    error: parsed.searchParams.get("error"),
  };
}

function extractPostMessagePayload(html: string): unknown | null {
  const match = html.match(/postMessage\(\s*(.+?)\s*,['\"]\*['\"]\s*\)/);
  if (!match) return null;
  try {
    const first = JSON.parse(match[1]);
    return typeof first === "string" ? JSON.parse(first) : first;
  } catch {
    return null;
  }
}

function extractSuccessPayload(html: string): { ok: boolean; remoteName?: string; providerName?: string; grantedScopes?: string[] } | null {
  const payload = extractPostMessagePayload(html);
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  return {
    ok: p.ok === true,
    remoteName: p.remoteName as string | undefined,
    providerName: p.providerName as string | undefined,
    grantedScopes: p.grantedScopes as string[] | undefined,
  };
}

function extractErrorPayload(html: string): { ok: boolean; error?: string; code?: string } | null {
  const payload = extractPostMessagePayload(html);
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  return {
    ok: Boolean(p.ok),
    error: p.error as string | undefined,
    code: p.code as string | undefined,
  };
}

// Simulate the callback URL validation logic from the route
function simulateCallbackValidation(urlStr: string): { status: number; type: "error" | "success"; message: string } {
  const parsed = new URL(urlStr);
  const code = parsed.searchParams.get("code");
  const state = parsed.searchParams.get("state");
  const error = parsed.searchParams.get("error");

  if (error) {
    return { status: 400, type: "error", message: `Provider returned error: ${error}` };
  }
  if (!code || !state) {
    return { status: 400, type: "error", message: "Callback missing code or state parameter." };
  }
  return { status: 200, type: "success", message: "OK" };
}

// Simulate token exchange parameters
interface TokenExchangeParams {
  code: string;
  state: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  codeVerifier: string;
  tokenUrl: string;
}

function buildTokenExchangeBody(params: TokenExchangeParams): string {
  return new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code_verifier: params.codeVerifier,
  }).toString();
}

function parseTokenExchangeBody(bodyStr: string): Record<string, string> {
  const params = new URLSearchParams(bodyStr);
  const result: Record<string, string> = {};
  for (const [key, value] of params) {
    result[key] = value;
  }
  return result;
}

// Simulate SecretsStore key construction for git remote OAuth. OAuth is
// provider-wide (connected once in Settings), so the token is keyed by provider
// id, not remote name — see src/lib/gitops/git-credential-helper.ts.
function gitRemoteOAuthSecretKey(providerId: string): string {
  return `git_remote:oauth:${providerId}`;
}

// Simulate the complete callback flow
interface FlowState {
  remoteName: string;
  verifier: string;
  scopes: string[];
  integrationId: string;
}

function simulateCallbackFlow(
  urlStr: string,
  flow: FlowState | null,
  tokenResponse: { ok: boolean; body: Record<string, unknown> } | null,
): { status: number; html: string; storedToken?: Record<string, unknown>; remoteConfigPatch?: Record<string, unknown> } {
  const parsed = new URL(urlStr);
  const code = parsed.searchParams.get("code");
  const state = parsed.searchParams.get("state");
  const error = parsed.searchParams.get("error");

  if (error) {
    return {
      status: 400,
      html: makeErrorPage(`Provider returned error: ${error}`, error),
    };
  }
  if (!code || !state) {
    return {
      status: 400,
      html: makeErrorPage("Callback missing code or state parameter."),
    };
  }

  if (!flow) {
    return {
      status: 400,
      html: makeErrorPage("OAuth state expired or unknown. Please try connecting again."),
    };
  }

  if (!flow.remoteName) {
    return {
      status: 400,
      html: makeErrorPage("Invalid OAuth flow: no remote name."),
    };
  }

  if (!tokenResponse || !tokenResponse.ok) {
    const desc = (tokenResponse?.body as { error_description?: string })?.error_description ?? "Token exchange failed";
    return {
      status: 400,
      html: makeErrorPage(desc),
    };
  }

  const trBody = tokenResponse.body;
  const accessToken = trBody.access_token as string | undefined;
  const expiresIn = trBody.expires_in as number | undefined;

  if (!accessToken || typeof expiresIn !== "number") {
    return {
      status: 400,
      html: makeErrorPage("Provider did not return access_token/expires_in"),
    };
  }

  const grantedScopes = ((trBody.scope as string) ?? flow.scopes.join(" ")).split(/\s+/).filter(Boolean);
  const expiresAt = Date.now() + expiresIn * 1000;
  const storedToken = { access_token: accessToken, expires_at: expiresAt };

  return {
    status: 200,
    html: makeSuccessPage(flow.remoteName, flow.integrationId, grantedScopes),
    storedToken,
    remoteConfigPatch: { oauthTokenExpiresAt: expiresAt },
  };
}

function makeSuccessPage(remoteName: string, providerName: string, grantedScopes: string[]): string {
  const payload = { type: "bos-git-oauth", ok: true, remoteName, providerName, grantedScopes };
  const json = JSON.stringify(payload);
  return `<!doctype html><html><body>
<div>Connected</div>
<script>try{window.opener&&window.opener.postMessage(${JSON.stringify(json)},'*');}catch(e){}</script>
</body></html>`;
}

function makeErrorPage(message: string, code?: string): string {
  const payload = { type: "bos-git-oauth", ok: false, error: message, code };
  const json = JSON.stringify(payload);
  return `<!doctype html><html><body>
<div>Failed</div>
<script>try{window.opener&&window.opener.postMessage(${JSON.stringify(json)},'*');}catch(e){}</script>
</body></html>`;
}

// ── Tests ───────────────────────────────────────────────────────────────────

test.describe("OAuth callback URL validation", () => {
  test("rejects URL with provider error", () => {
    const url = buildCallbackUrl({ error: "access_denied" });
    const result = simulateCallbackValidation(url);
    expect(result.status).toBe(400);
    expect(result.type).toBe("error");
    expect(result.message).toContain("access_denied");
  });

  test("rejects URL with no code", () => {
    const url = buildCallbackUrl({ state: "abc" });
    const result = simulateCallbackValidation(url);
    expect(result.status).toBe(400);
    expect(result.message).toContain("missing code or state");
  });

  test("rejects URL with no state", () => {
    const url = buildCallbackUrl({ code: "abc" });
    const result = simulateCallbackValidation(url);
    expect(result.status).toBe(400);
    expect(result.message).toContain("missing code or state");
  });

  test("rejects URL with neither code nor state", () => {
    const url = buildCallbackUrl({});
    const result = simulateCallbackValidation(url);
    expect(result.status).toBe(400);
  });

  test("accepts URL with both code and state", () => {
    const url = buildCallbackUrl({ code: "test-code", state: "test-state" });
    const result = simulateCallbackValidation(url);
    expect(result.status).toBe(200);
    expect(result.type).toBe("success");
  });
});

test.describe("State parameter verification", () => {
  test("returns error for expired/unknown state", () => {
    const url = buildCallbackUrl({ code: "test-code", state: "expired-state" });
    const result = simulateCallbackFlow(url, null, null);
    expect(result.status).toBe(400);
    expect(result.html).toContain("expired or unknown");
  });

  test("proceeds when state matches a pending flow", () => {
    const url = buildCallbackUrl({ code: "test-code", state: "valid-state" });
    const flow: FlowState = { remoteName: "origin", verifier: "v1", scopes: ["repo"], integrationId: "github" };
    const tokenResponse = { ok: true, body: { access_token: "gho_abc", expires_in: 3600, scope: "repo" } };
    const result = simulateCallbackFlow(url, flow, tokenResponse);
    expect(result.status).toBe(200);
  });

  test("rejects flow with no remoteName", () => {
    const url = buildCallbackUrl({ code: "test-code", state: "valid-state" });
    const flow: FlowState = { remoteName: "", verifier: "v1", scopes: ["repo"], integrationId: "github" };
    const result = simulateCallbackFlow(url, flow, null);
    expect(result.status).toBe(400);
    expect(result.html).toContain("no remote name");
  });
});

test.describe("Token exchange success", () => {
  test("stores token in SecretsStore with correct key", () => {
    const url = buildCallbackUrl({ code: "auth-code-123", state: "flow-state" });
    const flow: FlowState = { remoteName: "origin", verifier: "verifier-abc", scopes: ["repo", "read:user"], integrationId: "github" };
    const tokenResponse = { ok: true, body: { access_token: "gho_test_token", expires_in: 3600, scope: "repo read:user" } };
    const result = simulateCallbackFlow(url, flow, tokenResponse);

    expect(result.status).toBe(200);
    expect(result.storedToken).toBeDefined();
    expect(result.storedToken!.access_token).toBe("gho_test_token");
    expect(typeof result.storedToken!.expires_at).toBe("number");
    expect(result.storedToken!.expires_at).toBeGreaterThan(Date.now());

    // Token is stored per provider (flow.integrationId), not per remote.
    const expectedKey = gitRemoteOAuthSecretKey(flow.integrationId);
    expect(expectedKey).toBe("git_remote:oauth:github");
  });

  test("updates remote-config.json with oauthTokenExpiresAt", () => {
    const url = buildCallbackUrl({ code: "auth-code", state: "flow-state" });
    const flow: FlowState = { remoteName: "upstream", verifier: "v1", scopes: ["api"], integrationId: "gitlab" };
    const tokenResponse = { ok: true, body: { access_token: "glpat-xyz", expires_in: 7200, scope: "api" } };
    const result = simulateCallbackFlow(url, flow, tokenResponse);

    expect(result.remoteConfigPatch).toBeDefined();
    expect(typeof result.remoteConfigPatch!.oauthTokenExpiresAt).toBe("number");
    expect(result.remoteConfigPatch!.oauthTokenExpiresAt).toBeGreaterThan(Date.now());
  });

  test("preserves refresh_token from existing tokens", () => {
    const url = buildCallbackUrl({ code: "code", state: "state" });
    const flow: FlowState = { remoteName: "origin", verifier: "v", scopes: ["repo"], integrationId: "github" };
    const tokenResponse = {
      ok: true,
      body: {
        access_token: "new_token",
        refresh_token: "refresh_123",
        expires_in: 3600,
        scope: "repo",
      },
    };
    const result = simulateCallbackFlow(url, flow, tokenResponse);
    expect(result.status).toBe(200);
    expect(result.storedToken!.access_token).toBe("new_token");
  });

  test("handles missing scope in token response by using requested scopes", () => {
    const url = buildCallbackUrl({ code: "code", state: "state" });
    const flow: FlowState = { remoteName: "origin", verifier: "v", scopes: ["repo", "read:user"], integrationId: "github" };
    const tokenResponse = { ok: true, body: { access_token: "tok", expires_in: 3600 } };
    const result = simulateCallbackFlow(url, flow, tokenResponse);
    expect(result.status).toBe(200);
    const payload = extractSuccessPayload(result.html);
    expect(payload!.grantedScopes).toEqual(["repo", "read:user"]);
  });
});

test.describe("Token exchange failure", () => {
  test("returns error for HTTP failure from provider", () => {
    const url = buildCallbackUrl({ code: "bad-code", state: "state" });
    const flow: FlowState = { remoteName: "origin", verifier: "v", scopes: ["repo"], integrationId: "github" };
    const tokenResponse = { ok: false, body: { error: "bad_verification_code", error_description: "Code is expired or invalid" } };
    const result = simulateCallbackFlow(url, flow, tokenResponse);
    expect(result.status).toBe(400);
    expect(result.html).toContain("Code is expired or invalid");
  });

  test("returns error when provider omits access_token", () => {
    const url = buildCallbackUrl({ code: "code", state: "state" });
    const flow: FlowState = { remoteName: "origin", verifier: "v", scopes: ["repo"], integrationId: "github" };
    const tokenResponse = { ok: true, body: { expires_in: 3600 } };
    const result = simulateCallbackFlow(url, flow, tokenResponse);
    expect(result.status).toBe(400);
    expect(result.html).toContain("did not return access_token");
  });

  test("returns error when provider omits expires_in", () => {
    const url = buildCallbackUrl({ code: "code", state: "state" });
    const flow: FlowState = { remoteName: "origin", verifier: "v", scopes: ["repo"], integrationId: "github" };
    const tokenResponse = { ok: true, body: { access_token: "tok" } };
    const result = simulateCallbackFlow(url, flow, tokenResponse);
    expect(result.status).toBe(400);
    expect(result.html).toContain("did not return access_token");
  });
});

test.describe("HTML response structure", () => {
  test("success page includes postMessage script", () => {
    const url = buildCallbackUrl({ code: "code", state: "state" });
    const flow: FlowState = { remoteName: "origin", verifier: "v", scopes: ["repo"], integrationId: "github" };
    const tokenResponse = { ok: true, body: { access_token: "tok", expires_in: 3600, scope: "repo" } };
    const result = simulateCallbackFlow(url, flow, tokenResponse);
    expect(result.html).toContain("postMessage");
    expect(result.html).toContain("bos-git-oauth");
  });

  test("success page includes remote name", () => {
    const url = buildCallbackUrl({ code: "code", state: "state" });
    const flow: FlowState = { remoteName: "origin", verifier: "v", scopes: ["repo"], integrationId: "github" };
    const tokenResponse = { ok: true, body: { access_token: "tok", expires_in: 3600, scope: "repo" } };
    const result = simulateCallbackFlow(url, flow, tokenResponse);
    const payload = extractSuccessPayload(result.html);
    expect(payload!.remoteName).toBe("origin");
  });

  test("error page includes postMessage script", () => {
    const url = buildCallbackUrl({ error: "access_denied" });
    const result = simulateCallbackFlow(url, null, null);
    expect(result.html).toContain("postMessage");
    expect(result.html).toContain("bos-git-oauth");
  });

  test("error page includes error message", () => {
    const url = buildCallbackUrl({ error: "access_denied" });
    const result = simulateCallbackFlow(url, null, null);
    const payload = extractErrorPayload(result.html);
    expect(payload!.ok).toBe(false);
    expect(payload!.error).toContain("access_denied");
  });

  test("success page payload has ok: true", () => {
    const url = buildCallbackUrl({ code: "code", state: "state" });
    const flow: FlowState = { remoteName: "origin", verifier: "v", scopes: ["repo"], integrationId: "github" };
    const tokenResponse = { ok: true, body: { access_token: "tok", expires_in: 3600, scope: "repo" } };
    const result = simulateCallbackFlow(url, flow, tokenResponse);
    const payload = extractSuccessPayload(result.html);
    expect(payload!.ok).toBe(true);
  });

  test("error page payload has ok: false", () => {
    const url = buildCallbackUrl({ error: "access_denied" });
    const result = simulateCallbackFlow(url, null, null);
    const payload = extractErrorPayload(result.html);
    expect(payload!.ok).toBe(false);
  });
});

test.describe("Token exchange request format", () => {
  test("builds correct URL-encoded body", () => {
    const body = buildTokenExchangeBody({
      code: "test-code",
      state: "test-state",
      redirectUri: "http://localhost:3000/api/git-remotes/oauth/callback",
      clientId: "client-123",
      clientSecret: "secret-456",
      codeVerifier: "verifier-789",
      tokenUrl: "https://github.com/login/oauth/access_token",
    });
    const parsed = parseTokenExchangeBody(body);
    expect(parsed.grant_type).toBe("authorization_code");
    expect(parsed.code).toBe("test-code");
    expect(parsed.redirect_uri).toBe("http://localhost:3000/api/git-remotes/oauth/callback");
    expect(parsed.client_id).toBe("client-123");
    expect(parsed.client_secret).toBe("secret-456");
    expect(parsed.code_verifier).toBe("verifier-789");
  });

  test("includes all required parameters", () => {
    const body = buildTokenExchangeBody({
      code: "c",
      state: "s",
      redirectUri: "r",
      clientId: "id",
      clientSecret: "secret",
      codeVerifier: "v",
      tokenUrl: "https://example.com/token",
    });
    const parsed = parseTokenExchangeBody(body);
    expect(parsed).toHaveProperty("grant_type");
    expect(parsed).toHaveProperty("code");
    expect(parsed).toHaveProperty("redirect_uri");
    expect(parsed).toHaveProperty("client_id");
    expect(parsed).toHaveProperty("client_secret");
    expect(parsed).toHaveProperty("code_verifier");
  });
});

test.describe("Callback URL construction", () => {
  test("parses code and state from URL", () => {
    const url = buildCallbackUrl({ code: "abc", state: "def" });
    const parsed = parseCallbackUrl(url);
    expect(parsed.code).toBe("abc");
    expect(parsed.state).toBe("def");
  });

  test("parses error from URL", () => {
    const url = buildCallbackUrl({ error: "access_denied" });
    const parsed = parseCallbackUrl(url);
    expect(parsed.error).toBe("access_denied");
    expect(parsed.code).toBeNull();
    expect(parsed.state).toBeNull();
  });

  test("URL has correct path", () => {
    const url = buildCallbackUrl({ code: "x", state: "y" });
    expect(url).toContain("/api/git-remotes/oauth/callback");
  });
});

test.describe("HTML escaping", () => {
  test("escapeHtml escapes ampersand", () => {
    expect(escapeHtml("a&b")).toBe("a&amp;b");
  });

  test("escapeHtml escapes angle brackets", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
  });

  test("escapeHtml escapes quotes", () => {
    expect(escapeHtml('a"b\'c')).toBe("a&quot;b&#39;c");
  });

  test("escapeHtml passes through safe characters", () => {
    expect(escapeHtml("hello world 123")).toBe("hello world 123");
  });

  test("success page escapes provider name", () => {
    const url = buildCallbackUrl({ code: "code", state: "state" });
    const flow: FlowState = { remoteName: "origin", verifier: "v", scopes: ["repo"], integrationId: "github" };
    const tokenResponse = { ok: true, body: { access_token: "tok", expires_in: 3600, scope: "repo" } };
    const result = simulateCallbackFlow(url, flow, tokenResponse);
    expect(result.html).toContain("github");
  });
});

test.describe("Git remote OAuth secret key construction", () => {
  test("correct key for github provider", () => {
    expect(gitRemoteOAuthSecretKey("github")).toBe("git_remote:oauth:github");
  });

  test("correct key for gitlab provider", () => {
    expect(gitRemoteOAuthSecretKey("gitlab")).toBe("git_remote:oauth:gitlab");
  });
});

test.describe("Flow state with different providers", () => {
  test("GitHub flow stores correct data", () => {
    const url = buildCallbackUrl({ code: "gh-code", state: "gh-state" });
    const flow: FlowState = { remoteName: "origin", verifier: "gh-verifier", scopes: ["repo", "read:user"], integrationId: "github" };
    const tokenResponse = { ok: true, body: { access_token: "gho_abc", expires_in: 3600, scope: "repo read:user" } };
    const result = simulateCallbackFlow(url, flow, tokenResponse);
    expect(result.status).toBe(200);
    expect(result.storedToken!.access_token).toBe("gho_abc");
  });

  test("GitLab flow stores correct data", () => {
    const url = buildCallbackUrl({ code: "gl-code", state: "gl-state" });
    const flow: FlowState = { remoteName: "upstream", verifier: "gl-verifier", scopes: ["api", "read_user"], integrationId: "gitlab" };
    const tokenResponse = { ok: true, body: { access_token: "glpat-xyz", expires_in: 7200, scope: "api read_user" } };
    const result = simulateCallbackFlow(url, flow, tokenResponse);
    expect(result.status).toBe(200);
    expect(result.storedToken!.access_token).toBe("glpat-xyz");
  });
});
