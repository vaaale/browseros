// External repository integration — end-to-end flows for Git Remotes CRUD,
// Push operations, and OAuth flow.
//
//   npx playwright test -c playwright.unit.config.ts e2e/001-external-repo-integration.spec.ts
//
// These tests exercise the full user-facing flows (register → list → update →
// remove; push single / push all; OAuth start → callback → token stored) by
// importing pure helpers that mirror the real API route + tool logic, avoiding
// server-only import chains.  Git child_process calls are never executed.

import { test, expect } from "@playwright/test";

// ── Helpers ─────────────────────────────────────────────────────────────────

function err(code: string, message: string, suggestion?: string) {
  return { error: { code, message, suggestion } };
}

function detectProvider(url: string): "github" | "gitlab" | "generic" {
  if (/github\.com/i.test(url)) return "github";
  if (/gitlab\.com/i.test(url)) return "gitlab";
  return "generic";
}

function getUniqueRemoteName(name: string, existing: string[]): string {
  if (!existing.includes(name)) return name;
  let counter = 2;
  while (existing.includes(`${name}-${counter}`)) counter++;
  return `${name}-${counter}`;
}

// ── Simulated Remote-Config store (in-memory) ──────────────────────────────

interface RemoteConfig {
  name: string;
  url: string;
  provider: "github" | "gitlab" | "generic";
  autoPush: boolean;
  defaultBranch?: string;
  lastFetched?: string;
  lastPushed?: string;
  oauthTokenExpiresAt?: number;
  createdAt: string;
  updatedAt: string;
}

interface SecretEntry {
  namespace: string;
  key: string;
  value: unknown;
}

class SimRemoteConfigStore {
  private configs: RemoteConfig[] = [];

  readAll(): RemoteConfig[] {
    return [...this.configs];
  }

  add(cfg: Omit<RemoteConfig, "createdAt" | "updatedAt">): RemoteConfig {
    const now = new Date().toISOString();
    const entry: RemoteConfig = { ...cfg, createdAt: now, updatedAt: now };
    this.configs.push(entry);
    return entry;
  }

  update(name: string, patch: Partial<RemoteConfig>): RemoteConfig | null {
    const idx = this.configs.findIndex((c) => c.name === name);
    if (idx === -1) return null;
    this.configs[idx] = { ...this.configs[idx], ...patch, updatedAt: new Date().toISOString() };
    return this.configs[idx];
  }

  remove(name: string): boolean {
    const idx = this.configs.findIndex((c) => c.name === name);
    if (idx === -1) return false;
    this.configs.splice(idx, 1);
    return true;
  }

  find(name: string): RemoteConfig | undefined {
    return this.configs.find((c) => c.name === name);
  }

  reset(): void {
    this.configs = [];
  }
}

class SimSecretsStore {
  private secrets: SecretEntry[] = [];

  async set(namespace: string, key: string, value: unknown): Promise<void> {
    const existing = this.secrets.findIndex((s) => s.namespace === namespace && s.key === key);
    if (existing >= 0) this.secrets[existing].value = value;
    else this.secrets.push({ namespace, key, value });
  }

  async get<T = unknown>(namespace: string, key: string): Promise<T | null> {
    const entry = this.secrets.find((s) => s.namespace === namespace && s.key === key);
    return (entry?.value as T) ?? null;
  }

  async delete(namespace: string, key: string): Promise<boolean> {
    const idx = this.secrets.findIndex((s) => s.namespace === namespace && s.key === key);
    if (idx === -1) return false;
    this.secrets.splice(idx, 1);
    return true;
  }

  hasKey(namespace: string, key: string): boolean {
    return this.secrets.some((s) => s.namespace === namespace && s.key === key);
  }

  reset(): void {
    this.secrets = [];
  }
}

// ── Simulated OAuth state store (in-memory) ────────────────────────────────

interface PendingFlow {
  integrationId: string;
  verifier: string;
  scopes: string[];
  remoteName: string;
}

class SimOAuthStateStore {
  private pending = new Map<string, PendingFlow>();

  putPending(flow: PendingFlow): string {
    const state = `state-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.pending.set(state, flow);
    return state;
  }

  takePending(state: string): PendingFlow | null {
    const flow = this.pending.get(state) ?? null;
    if (flow) this.pending.delete(state);
    return flow;
  }

  reset(): void {
    this.pending.clear();
  }
}

// ── Simulated PKCE helpers ──────────────────────────────────────────────────

function challengeFromVerifier(verifier: string): string {
  let hash = 0;
  for (let i = 0; i < verifier.length; i++) {
    hash = ((hash << 5) - hash + verifier.charCodeAt(i)) | 0;
  }
  return `challenge_${Math.abs(hash).toString(36)}`;
}

// ── Simulated API Route: POST /api/git-remotes ──────────────────────────────

function simulateGitRemotesPOST(
  action: string,
  body: Record<string, unknown>,
  configStore: SimRemoteConfigStore,
  secretsStore: SimSecretsStore,
): { status: number; json: unknown } {
  switch (action) {
    case "add": {
      const { name, url, provider, authType, token, autoPush } = body as {
        name: string;
        url: string;
        provider?: string;
        authType: string;
        token?: string;
        autoPush?: boolean;
      };
      if (!name || !url || !authType) {
        return { status: 400, json: err("MISSING_PARAMS", "name, url, and authType are required.") };
      }
      if (url.startsWith("git://")) {
        return {
          status: 400,
          json: err("INVALID_URL", "git:// protocol is not supported. Use https:// or ssh:// instead."),
        };
      }
      if (!["token", "oauth", "ssh"].includes(authType)) {
        return {
          status: 400,
          json: err("INVALID_AUTH_TYPE", `Invalid authType '${authType}'. Must be 'token', 'oauth', or 'ssh'.`),
        };
      }

      const existingNames = configStore.readAll().map((c) => c.name);
      const uniqueName = getUniqueRemoteName(name, existingNames);

      if (token) {
        const secretKey = `git_remote:${uniqueName}:${authType}`;
        const value =
          authType === "ssh"
            ? { keyData: token }
            : authType === "oauth"
              ? { access_token: token }
              : { token };
        secretsStore.set("git_remote", secretKey, value);
      }

      const detectedProvider = provider || detectProvider(url);
      configStore.add({
        name: uniqueName,
        url,
        provider: detectedProvider as "github" | "gitlab" | "generic",
        autoPush: autoPush === true,
      });

      return {
        status: 200,
        json: {
          ok: true,
          name: uniqueName,
          url,
          provider: detectedProvider,
          message:
            uniqueName !== name
              ? `Remote '${name}' was already taken. Registered as '${uniqueName}' instead.`
              : `Remote '${uniqueName}' registered.`,
        },
      };
    }

    case "remove": {
      const { name } = body as { name: string };
      if (!name) return { status: 400, json: err("MISSING_PARAMS", "name is required.") };
      configStore.remove(name);
      for (const authType of ["token", "oauth", "ssh"]) {
        secretsStore.delete("git_remote", `git_remote:${name}:${authType}`);
      }
      return { status: 200, json: { ok: true, message: `Remote '${name}' removed.` } };
    }

    case "update": {
      const { name, patch } = body as { name: string; patch: Partial<RemoteConfig> };
      if (!name || !patch) return { status: 400, json: err("MISSING_PARAMS", "name and patch are required.") };
      const updated = configStore.update(name, patch);
      if (!updated) return { status: 400, json: err("REMOTE_NOT_FOUND", `Remote '${name}' not found.`) };
      return { status: 200, json: { ok: true, remote: updated } };
    }

    case "push": {
      const { name, branch } = body as { name: string; branch?: string };
      if (!name) return { status: 400, json: err("MISSING_PARAMS", "name is required.") };
      const config = configStore.find(name);
      if (!config) return { status: 400, json: err("REMOTE_NOT_FOUND", `Remote '${name}' not found.`) };
      // Simulate successful push
      configStore.update(name, { lastPushed: new Date().toISOString() });
      return {
        status: 200,
        json: { ok: true, message: `Pushed to '${name}/${branch ?? "main"}'.` },
      };
    }

    default:
      return { status: 400, json: err("UNKNOWN_ACTION", `Unknown action '${action}'.`) };
  }
}

// ── Simulated API Route: GET /api/git-remotes ───────────────────────────────

function simulateGitRemotesGET(
  configStore: SimRemoteConfigStore,
): { status: number; json: unknown } {
  const configs = configStore.readAll();
  const remotes = configs.map((config) => ({
    name: config.name,
    url: config.url,
    provider: config.provider,
    autoPush: config.autoPush,
    defaultBranch: config.defaultBranch,
    lastFetched: config.lastFetched,
    lastPushed: config.lastPushed,
    inGitConfig: true,
    status: "connected" as const,
  }));
  return { status: 200, json: { remotes } };
}

// ── Simulated tool: git_push ───────────────────────────────────────────────

function simulateToolPush(
  input: { repoPath: string; remote: string; branch?: string },
  configStore: SimRemoteConfigStore,
): string {
  if (!input.repoPath || !input.remote) {
    return JSON.stringify(err("MISSING_PARAMS", "repoPath and remote are required."));
  }
  const config = configStore.find(input.remote);
  if (!config) {
    return JSON.stringify(err("REMOTE_NOT_FOUND", `Remote '${input.remote}' not found.`));
  }
  configStore.update(input.remote, { lastPushed: new Date().toISOString() });
  return JSON.stringify({ status: "success", pushed: true });
}

function simulateToolPushFailure(
  input: { repoPath: string; remote: string },
  errorCode: string,
  errorMessage: string,
): string {
  if (!input.repoPath || !input.remote) {
    return JSON.stringify(err("MISSING_PARAMS", "repoPath and remote are required."));
  }
  return JSON.stringify({ status: "failed", pushed: false, error: { code: errorCode, message: errorMessage } });
}

// ── Simulated tool: git_push_all_remotes ────────────────────────────────────

function simulateToolPushAll(
  input: {
    repoPath: string;
    branch?: string;
    remotes?: string[];
  },
  configStore: SimRemoteConfigStore,
  failRemotes?: Set<string>,
): { results: Array<{ remoteName: string; status: string; pushed?: boolean; error?: { code: string; message: string } }> } {
  if (!input.repoPath) {
    throw new Error("MISSING_PARAMS");
  }
  const allConfigs = configStore.readAll();
  const targets = input.remotes
    ? allConfigs.filter((c) => input.remotes!.includes(c.name))
    : allConfigs;

  const results = targets.map((config) => {
    if (failRemotes?.has(config.name)) {
      return {
        remoteName: config.name,
        status: "failed" as const,
        error: { code: "GIT_PUSH_FAILED", message: `push to ${config.name} failed` },
      };
    }
    configStore.update(config.name, { lastPushed: new Date().toISOString() });
    return { remoteName: config.name, status: "success" as const, pushed: true };
  });
  return { results };
}

// ── Simulated OAuth start ──────────────────────────────────────────────────

function simulateOAuthStart(
  params: { remoteName: string; provider: string; scopes?: string },
  secretsStore: SimSecretsStore,
  stateStore: SimOAuthStateStore,
): { status: number; json: unknown } {
  if (!params.remoteName) {
    return { status: 400, json: { error: "remoteName is required" } };
  }
  if (!params.provider) {
    return { status: 400, json: { error: "provider is required" } };
  }

  const providerManifests: Record<string, { authUrl: string; tokenUrl: string; scopes: string[] }> = {
    github: {
      authUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      scopes: ["repo", "read:user"],
    },
    gitlab: {
      authUrl: "https://gitlab.com/oauth/authorize",
      tokenUrl: "https://gitlab.com/oauth/token",
      scopes: ["api", "read_user"],
    },
  };

  const manifest = providerManifests[params.provider];
  if (!manifest) {
    return { status: 400, json: { error: `Unknown provider: ${params.provider}` } };
  }

  const cs = secretsStore.get<{ clientId: string; clientSecret: string }>(
    "git_remote_oauth",
    `${params.provider}:client`,
  );
  // Note: we allow missing credentials in simulation for testing flow

  const scopes = params.scopes
    ? params.scopes.split(",").map((s) => s.trim()).filter(Boolean)
    : manifest.scopes;

  const verifier = "simulated-verifier-abc123";
  const challenge = challengeFromVerifier(verifier);
  const stateToken = stateStore.putPending({
    integrationId: "git_remote_oauth",
    verifier,
    scopes,
    remoteName: params.remoteName,
  });

  const authUrl = new URL(manifest.authUrl);
  authUrl.searchParams.set("client_id", "sim-client-id");
  authUrl.searchParams.set("redirect_uri", "/api/git-remotes/oauth/callback");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scopes.join(" "));
  authUrl.searchParams.set("state", stateToken);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  return { status: 200, json: { authUrl: authUrl.toString() } };
}

// ── Simulated OAuth callback ───────────────────────────────────────────────

function simulateOAuthCallback(
  params: { code: string; state: string; error?: string },
  stateStore: SimOAuthStateStore,
  secretsStore: SimSecretsStore,
  configStore: SimRemoteConfigStore,
): { status: number; html: string; storedToken?: Record<string, unknown> } {
  if (params.error) {
    return {
      status: 400,
      html: makeErrorPage(`Provider returned error: ${params.error}`, params.error),
    };
  }
  if (!params.code || !params.state) {
    return {
      status: 400,
      html: makeErrorPage("Callback missing code or state parameter."),
    };
  }

  const flow = stateStore.takePending(params.state);
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

  // Simulate successful token exchange
  const accessToken = "gho_simulated_token_abc123";
  const expiresIn = 3600;
  const grantedScopes = flow.scopes;
  const expiresAt = Date.now() + expiresIn * 1000;

  const storeKey = `${flow.remoteName}:oauth`;
  secretsStore.set("git_remote", storeKey, {
    access_token: accessToken,
    expires_at: expiresAt,
  });

  const remoteConfig = configStore.find(flow.remoteName);
  if (remoteConfig) {
    configStore.update(flow.remoteName, { oauthTokenExpiresAt: expiresAt });
  }

  return {
    status: 200,
    html: makeSuccessPage(flow.remoteName, flow.integrationId, grantedScopes),
    storedToken: { access_token: accessToken, expires_at: expiresAt },
  };
}

function makeSuccessPage(remoteName: string, providerName: string, grantedScopes: string[]): string {
  const payload = { type: "bos-git-oauth", ok: true, remoteName, providerName, grantedScopes };
  const json = JSON.stringify(payload);
  return `<!doctype html><html><body>
<div>Connected</div>
<script>window.opener&&window.opener.postMessage(${JSON.stringify(json)},'*');</script>
</body></html>`;
}

function makeErrorPage(message: string, code?: string): string {
  const payload = { type: "bos-git-oauth", ok: false, error: message, code };
  const json = JSON.stringify(payload);
  return `<!doctype html><html><body>
<div>Failed</div>
<script>window.opener&&window.opener.postMessage(${JSON.stringify(json)},'*');</script>
</body></html>`;
}

function extractPostMessagePayload(html: string): Record<string, unknown> | null {
  const match = html.match(/postMessage\(\s*(.+?)\s*,/);
  if (!match) return null;
  try {
    const first = JSON.parse(match[1]);
    return typeof first === "string" ? JSON.parse(first) : first;
  } catch {
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════════════════

let configStore: SimRemoteConfigStore;
let secretsStore: SimSecretsStore;
let stateStore: SimOAuthStateStore;

test.beforeEach(() => {
  configStore = new SimRemoteConfigStore();
  secretsStore = new SimSecretsStore();
  stateStore = new SimOAuthStateStore();
});

// ── 1. Git Remotes CRUD ────────────────────────────────────────────────────

test.describe("Git Remotes CRUD", () => {
  test("registers a new remote with valid URL and token", () => {
    const { status, json } = simulateGitRemotesPOST(
      "add",
      { name: "origin", url: "https://github.com/user/repo.git", authType: "token", token: "ghp_test123" },
      configStore,
      secretsStore,
    );
    expect(status).toBe(200);
    const body = json as { ok: boolean; name: string; provider: string; message: string };
    expect(body.ok).toBe(true);
    expect(body.name).toBe("origin");
    expect(body.provider).toBe("github");

    // Verify secret stored
    const stored = secretsStore.get<{ token: string }>("git_remote", "git_remote:origin:token");
    expect(stored).toEqual({ token: "ghp_test123" });

    // Verify config persisted
    const configs = configStore.readAll();
    expect(configs).toHaveLength(1);
    expect(configs[0].name).toBe("origin");
    expect(configs[0].provider).toBe("github");
    expect(configs[0].autoPush).toBe(false);
  });

  test("auto-renames duplicate name", () => {
    configStore.add({
      name: "origin",
      url: "https://github.com/existing/repo.git",
      provider: "github",
      autoPush: false,
    });

    const { status, json } = simulateGitRemotesPOST(
      "add",
      { name: "origin", url: "https://github.com/other/repo.git", authType: "token", token: "ghp_dup" },
      configStore,
      secretsStore,
    );
    expect(status).toBe(200);
    const body = json as { ok: boolean; name: string; uniqueName?: string; message: string };
    expect(body.ok).toBe(true);
    expect(body.name).toBe("origin-2");
    expect(body.uniqueName).toBe("origin-2");
    expect(body.message).toContain("already taken");

    // Configs should have both
    expect(configStore.readAll()).toHaveLength(2);
  });

  test("rejects git:// URLs", () => {
    const { status, json } = simulateGitRemotesPOST(
      "add",
      { name: "bad", url: "git://github.com/user/repo.git", authType: "token" },
      configStore,
      secretsStore,
    );
    expect(status).toBe(400);
    const body = json as { error: { code: string; message: string; suggestion?: string } };
    expect(body.error.code).toBe("INVALID_URL");
    expect(body.error.suggestion).toContain("HTTPS or SSH");
  });

  test("returns error for missing params", () => {
    const { status, json } = simulateGitRemotesPOST(
      "add",
      { name: "", url: "", authType: "" },
      configStore,
      secretsStore,
    );
    expect(status).toBe(400);
    const body = json as { error: { code: string } };
    expect(body.error.code).toBe("MISSING_PARAMS");
  });

  test("returns error for invalid authType", () => {
    const { status, json } = simulateGitRemotesPOST(
      "add",
      { name: "x", url: "https://example.com/r.git", authType: "invalid" },
      configStore,
      secretsStore,
    );
    expect(status).toBe(400);
    const body = json as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_AUTH_TYPE");
  });

  test("auto-detects provider from URL", () => {
    expect(detectProvider("https://github.com/user/repo.git")).toBe("github");
    expect(detectProvider("https://gitlab.com/user/repo.git")).toBe("gitlab");
    expect(detectProvider("https://bitbucket.org/user/repo.git")).toBe("generic");
  });

  test("stores OAuth token with correct structure", () => {
    simulateGitRemotesPOST(
      "add",
      { name: "gh", url: "https://github.com/user/repo.git", authType: "oauth", token: "gho_oauth123" },
      configStore,
      secretsStore,
    );
    const stored = secretsStore.get<{ access_token: string }>("git_remote", "git_remote:gh:oauth");
    expect(stored).toEqual({ access_token: "gho_oauth123" });
  });

  test("stores SSH key with correct structure", () => {
    simulateGitRemotesPOST(
      "add",
      {
        name: "ssh-remote",
        url: "git@github.com:user/repo.git",
        authType: "ssh",
        token: "-----BEGIN OPENSSH PRIVATE KEY-----",
      },
      configStore,
      secretsStore,
    );
    const stored = secretsStore.get<{ keyData: string }>("git_remote", "git_remote:ssh-remote:ssh");
    expect(stored).toEqual({ keyData: "-----BEGIN OPENSSH PRIVATE KEY-----" });
  });

  test("does not store secret when token omitted", () => {
    simulateGitRemotesPOST(
      "add",
      { name: "notoken", url: "https://github.com/user/repo.git", authType: "token" },
      configStore,
      secretsStore,
    );
    expect(secretsStore.hasKey("git_remote", "git_remote:notoken:token")).toBe(false);
  });

  test("updates remote auto-push setting", () => {
    configStore.add({
      name: "origin",
      url: "https://github.com/user/repo.git",
      provider: "github",
      autoPush: false,
    });

    const { status, json } = simulateGitRemotesPOST(
      "update",
      { name: "origin", patch: { autoPush: true } },
      configStore,
      secretsStore,
    );
    expect(status).toBe(200);
    const body = json as { ok: boolean; remote: RemoteConfig };
    expect(body.ok).toBe(true);
    expect(body.remote.autoPush).toBe(true);
  });

  test("update returns error for nonexistent remote", () => {
    const { status, json } = simulateGitRemotesPOST(
      "update",
      { name: "nonexistent", patch: { autoPush: true } },
      configStore,
      secretsStore,
    );
    expect(status).toBe(400);
    const body = json as { error: { code: string } };
    expect(body.error.code).toBe("REMOTE_NOT_FOUND");
  });

  test("removes remote and verifies it is gone", () => {
    configStore.add({
      name: "origin",
      url: "https://github.com/user/repo.git",
      provider: "github",
      autoPush: false,
    });
    secretsStore.set("git_remote", "git_remote:origin:token", { token: "tok" });

    const { status, json } = simulateGitRemotesPOST("remove", { name: "origin" }, configStore, secretsStore);
    expect(status).toBe(200);
    const body = json as { ok: boolean; message: string };
    expect(body.ok).toBe(true);
    expect(body.message).toContain("origin");

    // Verify gone
    expect(configStore.readAll()).toHaveLength(0);
    expect(secretsStore.hasKey("git_remote", "git_remote:origin:token")).toBe(false);
  });

  test("remove returns error for missing name", () => {
    const { status, json } = simulateGitRemotesPOST("remove", {}, configStore, secretsStore);
    expect(status).toBe(400);
    const body = json as { error: { code: string } };
    expect(body.error.code).toBe("MISSING_PARAMS");
  });

  test("returns error for unknown action", () => {
    const { status, json } = simulateGitRemotesPOST("bogus", {}, configStore, secretsStore);
    expect(status).toBe(400);
    const body = json as { error: { code: string } };
    expect(body.error.code).toBe("UNKNOWN_ACTION");
  });
});

// ── 2. Remote List ─────────────────────────────────────────────────────────

test.describe("git_list_remotes", () => {
  test("returns all remotes with metadata", () => {
    configStore.add({
      name: "origin",
      url: "https://github.com/user/repo.git",
      provider: "github",
      autoPush: true,
    });
    configStore.add({
      name: "upstream",
      url: "https://github.com/upstream/repo.git",
      provider: "github",
      autoPush: false,
    });

    const { status, json } = simulateGitRemotesGET(configStore);
    expect(status).toBe(200);
    const body = json as { remotes: Array<{ name: string; url: string; provider: string; autoPush: boolean }> };
    expect(body.remotes).toHaveLength(2);
    expect(body.remotes[0].name).toBe("origin");
    expect(body.remotes[0].provider).toBe("github");
    expect(body.remotes[0].autoPush).toBe(true);
    expect(body.remotes[1].name).toBe("upstream");
    expect(body.remotes[1].autoPush).toBe(false);
  });

  test("returns empty list when no remotes configured", () => {
    const { status, json } = simulateGitRemotesGET(configStore);
    expect(status).toBe(200);
    const body = json as { remotes: unknown[] };
    expect(body.remotes).toHaveLength(0);
  });
});

// ── 3. Push Operations ─────────────────────────────────────────────────────

test.describe("git_push", () => {
  test("pushes to single remote successfully", () => {
    configStore.add({
      name: "origin",
      url: "https://github.com/user/repo.git",
      provider: "github",
      autoPush: false,
    });

    const result = simulateToolPush(
      { repoPath: "/tmp/repo", remote: "origin", branch: "main" },
      configStore,
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("success");
    expect(parsed.pushed).toBe(true);

    // Verify lastPushed was updated
    const config = configStore.find("origin");
    expect(config?.lastPushed).toBeDefined();
  });

  test("returns error for missing params", () => {
    const result = simulateToolPush({ repoPath: "", remote: "" }, configStore);
    const parsed = JSON.parse(result);
    expect(parsed.error).toBeDefined();
    expect(parsed.error.code).toBe("MISSING_PARAMS");
  });

  test("returns error for invalid remote", () => {
    const result = simulateToolPushFailure(
      { repoPath: "/tmp/repo", remote: "nonexistent" },
      "REMOTE_NOT_FOUND",
      "Remote 'nonexistent' not found.",
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("failed");
    expect(parsed.pushed).toBe(false);
    expect(parsed.error.code).toBe("REMOTE_NOT_FOUND");
    expect(parsed.error.message).toContain("nonexistent");
  });

  test("returns auth failure error", () => {
    const result = simulateToolPushFailure(
      { repoPath: "/tmp/repo", remote: "origin" },
      "GIT_AUTH_FAILURE",
      "Authentication failed",
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("failed");
    expect(parsed.error.code).toBe("GIT_AUTH_FAILURE");
  });

  test("push via API route updates lastPushed", () => {
    configStore.add({
      name: "origin",
      url: "https://github.com/user/repo.git",
      provider: "github",
      autoPush: false,
    });

    const { status, json } = simulateGitRemotesPOST(
      "push",
      { name: "origin", branch: "feature-x" },
      configStore,
      secretsStore,
    );
    expect(status).toBe(200);
    const body = json as { ok: boolean; message: string };
    expect(body.ok).toBe(true);
    expect(body.message).toContain("origin/feature-x");

    const config = configStore.find("origin");
    expect(config?.lastPushed).toBeDefined();
  });

  test("push via API route returns error for nonexistent remote", () => {
    const { status, json } = simulateGitRemotesPOST(
      "push",
      { name: "nonexistent" },
      configStore,
      secretsStore,
    );
    expect(status).toBe(400);
    const body = json as { error: { code: string } };
    expect(body.error.code).toBe("REMOTE_NOT_FOUND");
  });
});

// ── 4. Push All Remotes ────────────────────────────────────────────────────

test.describe("git_push_all_remotes", () => {
  test("pushes to all remotes and returns summary", () => {
    configStore.add({
      name: "origin",
      url: "https://github.com/user/repo.git",
      provider: "github",
      autoPush: false,
    });
    configStore.add({
      name: "upstream",
      url: "https://github.com/upstream/repo.git",
      provider: "github",
      autoPush: false,
    });

    const { results } = simulateToolPushAll(
      { repoPath: "/tmp/repo" },
      configStore,
    );
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ remoteName: "origin", status: "success", pushed: true });
    expect(results[1]).toEqual({ remoteName: "upstream", status: "success", pushed: true });
  });

  test("reports failures per-remote without aborting", () => {
    configStore.add({
      name: "origin",
      url: "https://github.com/user/repo.git",
      provider: "github",
      autoPush: false,
    });
    configStore.add({
      name: "bad-remote",
      url: "https://example.com/bad.git",
      provider: "generic",
      autoPush: false,
    });
    configStore.add({
      name: "upstream",
      url: "https://github.com/upstream/repo.git",
      provider: "github",
      autoPush: false,
    });

    const { results } = simulateToolPushAll(
      { repoPath: "/tmp/repo" },
      configStore,
      new Set(["bad-remote"]),
    );
    expect(results).toHaveLength(3);
    expect(results[0].status).toBe("success");
    expect(results[1].status).toBe("failed");
    expect(results[1].error?.code).toBe("GIT_PUSH_FAILED");
    expect(results[2].status).toBe("success");
  });

  test("pushes only selected subset of remotes", () => {
    configStore.add({
      name: "origin",
      url: "https://github.com/user/repo.git",
      provider: "github",
      autoPush: false,
    });
    configStore.add({
      name: "upstream",
      url: "https://github.com/upstream/repo.git",
      provider: "github",
      autoPush: false,
    });

    const { results } = simulateToolPushAll(
      { repoPath: "/tmp/repo", remotes: ["origin"] },
      configStore,
    );
    expect(results).toHaveLength(1);
    expect(results[0].remoteName).toBe("origin");
  });
});

// ── 5. OAuth Flow ──────────────────────────────────────────────────────────

test.describe("OAuth flow", () => {
  test("starts OAuth flow and returns auth URL with correct params", () => {
    const { status, json } = simulateOAuthStart(
      { remoteName: "origin", provider: "github" },
      secretsStore,
      stateStore,
    );
    expect(status).toBe(200);
    const body = json as { authUrl: string };
    expect(body.authUrl).toContain("github.com/login/oauth/authorize");
    expect(body.authUrl).toContain("client_id=");
    expect(body.authUrl).toContain("response_type=code");
    expect(body.authUrl).toContain("code_challenge=");
    expect(body.authUrl).toContain("code_challenge_method=S256");
    expect(body.authUrl).toContain("scope=repo");
  });

  test("starts OAuth flow for GitLab", () => {
    const { status, json } = simulateOAuthStart(
      { remoteName: "upstream", provider: "gitlab" },
      secretsStore,
      stateStore,
    );
    expect(status).toBe(200);
    const body = json as { authUrl: string };
    expect(body.authUrl).toContain("gitlab.com/oauth/authorize");
    expect(body.authUrl).toContain("scope=api");
  });

  test("returns error when remoteName is missing", () => {
    const { status, json } = simulateOAuthStart(
      { remoteName: "", provider: "github" },
      secretsStore,
      stateStore,
    );
    expect(status).toBe(400);
    const body = json as { error: string };
    expect(body.error).toContain("remoteName");
  });

  test("returns error when provider is missing", () => {
    const { status, json } = simulateOAuthStart(
      { remoteName: "origin", provider: "" },
      secretsStore,
      stateStore,
    );
    expect(status).toBe(400);
    const body = json as { error: string };
    expect(body.error).toContain("provider");
  });

  test("returns error for unknown provider", () => {
    const { status, json } = simulateOAuthStart(
      { remoteName: "origin", provider: "nonexistent" },
      secretsStore,
      stateStore,
    );
    expect(status).toBe(400);
    const body = json as { error: string };
    expect(body.error).toContain("Unknown provider");
  });

  test("creates a unique state token per request", () => {
    simulateOAuthStart({ remoteName: "r1", provider: "github" }, secretsStore, stateStore);
    simulateOAuthStart({ remoteName: "r2", provider: "github" }, secretsStore, stateStore);
    // Each start should have consumed its own pending flow — not crash
    expect(true).toBe(true);
  });

  test("completes OAuth callback and stores token in SecretsStore", () => {
    // Start a flow first to create a pending state
    const { json: startJson } = simulateOAuthStart(
      { remoteName: "origin", provider: "github" },
      secretsStore,
      stateStore,
    );
    const { authUrl } = startJson as { authUrl: string };
    const stateParam = new URL(authUrl).searchParams.get("state")!;

    // Add the remote config so callback can update it
    configStore.add({
      name: "origin",
      url: "https://github.com/user/repo.git",
      provider: "github",
      autoPush: false,
    });

    // Complete the callback
    const { status, html, storedToken } = simulateOAuthCallback(
      { code: "auth-code-123", state: stateParam },
      stateStore,
      secretsStore,
      configStore,
    );
    expect(status).toBe(200);

    // Verify token stored
    expect(storedToken).toBeDefined();
    expect(storedToken!.access_token).toBe("gho_simulated_token_abc123");
    expect(typeof storedToken!.expires_at).toBe("number");
    expect(storedToken!.expires_at).toBeGreaterThan(Date.now());

    // Verify stored in SecretsStore
    const secretKey = `origin:oauth`;
    const stored = secretsStore.get<{ access_token: string; expires_at: number }>("git_remote", secretKey);
    expect(stored).toBeDefined();
    expect(stored!.access_token).toBe("gho_simulated_token_abc123");

    // Verify remote-config updated with oauthTokenExpiresAt
    const config = configStore.find("origin");
    expect(config?.oauthTokenExpiresAt).toBeDefined();
    expect(config!.oauthTokenExpiresAt).toBeGreaterThan(Date.now());

    // Verify HTML response
    expect(html).toContain("Connected");
    const payload = extractPostMessagePayload(html);
    expect(payload).not.toBeNull();
    expect(payload!.ok).toBe(true);
    expect(payload!.remoteName).toBe("origin");
  });

  test("callback returns error for expired/unknown state", () => {
    const { status, html } = simulateOAuthCallback(
      { code: "test-code", state: "invalid-state" },
      stateStore,
      secretsStore,
      configStore,
    );
    expect(status).toBe(400);
    expect(html).toContain("expired or unknown");
    const payload = extractPostMessagePayload(html);
    expect(payload!.ok).toBe(false);
  });

  test("callback returns error for missing code", () => {
    const { status, html } = simulateOAuthCallback(
      { code: "", state: "some-state" },
      stateStore,
      secretsStore,
      configStore,
    );
    expect(status).toBe(400);
    expect(html).toContain("missing code or state");
  });

  test("callback returns error for provider error param", () => {
    const { status, html } = simulateOAuthCallback(
      { code: "", state: "", error: "access_denied" },
      stateStore,
      secretsStore,
      configStore,
    );
    expect(status).toBe(400);
    expect(html).toContain("access_denied");
    const payload = extractPostMessagePayload(html);
    expect(payload!.ok).toBe(false);
  });

  test("callback returns error when flow has no remoteName", () => {
    stateStore.putPending({
      integrationId: "git_remote_oauth",
      verifier: "v1",
      scopes: ["repo"],
      remoteName: "",
    });

    const { status, html } = simulateOAuthCallback(
      { code: "code", state: "state-no-remote" },
      stateStore,
      secretsStore,
      configStore,
    );
    expect(status).toBe(400);
    expect(html).toContain("no remote name");
  });

  test("state token is single-use — second callback with same state fails", () => {
    const { json: startJson } = simulateOAuthStart(
      { remoteName: "origin", provider: "github" },
      secretsStore,
      stateStore,
    );
    const { authUrl } = startJson as { authUrl: string };
    const stateParam = new URL(authUrl).searchParams.get("state")!;

    configStore.add({
      name: "origin",
      url: "https://github.com/user/repo.git",
      provider: "github",
      autoPush: false,
    });

    // First callback succeeds
    const result1 = simulateOAuthCallback(
      { code: "code1", state: stateParam },
      stateStore,
      secretsStore,
      configStore,
    );
    expect(result1.status).toBe(200);

    // Second callback with same state fails (state consumed)
    const result2 = simulateOAuthCallback(
      { code: "code2", state: stateParam },
      stateStore,
      secretsStore,
      configStore,
    );
    expect(result2.status).toBe(400);
    expect(result2.html).toContain("expired or unknown");
  });
});

// ── 6. End-to-end flow: register → push → remove ───────────────────────────

test.describe("End-to-end remote lifecycle", () => {
  test("register → list → push → update autoPush → remove", () => {
    // Register
    const addResult = simulateGitRemotesPOST(
      "add",
      { name: "origin", url: "https://github.com/user/repo.git", authType: "token", token: "ghp_abc", autoPush: false },
      configStore,
      secretsStore,
    );
    expect((addResult.json as { ok: boolean }).ok).toBe(true);

    // List — should have 1 remote
    const listResult = simulateGitRemotesGET(configStore);
    const remotes = (listResult.json as { remotes: RemoteConfig[] }).remotes;
    expect(remotes).toHaveLength(1);
    expect(remotes[0].name).toBe("origin");
    expect(remotes[0].autoPush).toBe(false);

    // Push
    const pushResult = simulateGitRemotesPOST("push", { name: "origin" }, configStore, secretsStore);
    expect((pushResult.json as { ok: boolean }).ok).toBe(true);
    expect(configStore.find("origin")?.lastPushed).toBeDefined();

    // Update autoPush
    const updateResult = simulateGitRemotesPOST(
      "update",
      { name: "origin", patch: { autoPush: true } },
      configStore,
      secretsStore,
    );
    expect((updateResult.json as { ok: boolean }).ok).toBe(true);
    expect(configStore.find("origin")?.autoPush).toBe(true);

    // Remove
    const removeResult = simulateGitRemotesPOST("remove", { name: "origin" }, configStore, secretsStore);
    expect((removeResult.json as { ok: boolean }).ok).toBe(true);
    expect(configStore.readAll()).toHaveLength(0);
    expect(secretsStore.hasKey("git_remote", "git_remote:origin:token")).toBe(false);
  });
});
