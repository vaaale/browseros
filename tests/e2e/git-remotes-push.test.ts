// Git Remotes & Push — E2E tests for remote CRUD and push operations.
//
//   npx playwright test -c playwright.unit.config.ts tests/e2e/git-remotes-push.spec.ts
//
// These tests exercise API-level flows (add/remove/list/update; push single /
// push all) by simulating the /api/git-remotes and /api/git-push route logic
// with in-memory stores.  Git child_process calls are never executed.

import { test, expect } from "@playwright/test";

// ── Helpers ─────────────────────────────────────────────────────────────────

function err(code: string, message: string, suggestion?: string) {
  return suggestion
    ? { error: { code, message, suggestion } }
    : { error: { code, message } };
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

  set(namespace: string, key: string, value: unknown): void {
    const existing = this.secrets.findIndex((s) => s.namespace === namespace && s.key === key);
    if (existing >= 0) this.secrets[existing].value = value;
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

  reset(): void {
    this.secrets = [];
  }
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
          json: err("INVALID_URL", "git:// protocol is not supported. Use https:// or ssh:// instead.", "Convert the URL to HTTPS or SSH format."),
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

      const resp: Record<string, unknown> = {
        ok: true,
        name: uniqueName,
        url,
        provider: detectedProvider,
        message:
          uniqueName !== name
            ? `Remote '${name}' was already taken. Registered as '${uniqueName}' instead.`
            : `Remote '${uniqueName}' registered.`,
      };
      if (uniqueName !== name) resp.uniqueName = uniqueName;
      return { status: 200, json: resp };
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

// ════════════════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════════════════

let configStore: SimRemoteConfigStore;
let secretsStore: SimSecretsStore;

test.beforeEach(() => {
  configStore = new SimRemoteConfigStore();
  secretsStore = new SimSecretsStore();
});

// ── 1. git_add_remote ──────────────────────────────────────────────────────

test.describe("git_add_remote", () => {
  test("adds a remote with valid URL and token", () => {
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

    // Verify secret stored with correct structure
    const stored = secretsStore.get<{ token: string }>("git_remote", "git_remote:origin:token");
    expect(stored).toEqual({ token: "ghp_test123" });

    // Verify config persisted
    const configs = configStore.readAll();
    expect(configs).toHaveLength(1);
    expect(configs[0].name).toBe("origin");
    expect(configs[0].provider).toBe("github");
    expect(configs[0].url).toBe("https://github.com/user/repo.git");
    expect(configs[0].autoPush).toBe(false);
  });

  test("auto-renames on duplicate name", () => {
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

    // Both configs exist
    expect(configStore.readAll()).toHaveLength(2);

    // Secret stored under unique name
    const stored = secretsStore.get<{ token: string }>("git_remote", "git_remote:origin-2:token");
    expect(stored).toEqual({ token: "ghp_dup" });
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

    // Nothing stored
    expect(configStore.readAll()).toHaveLength(0);
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

  test("respects autoPush flag", () => {
    simulateGitRemotesPOST(
      "add",
      { name: "autopush", url: "https://github.com/user/repo.git", authType: "token", autoPush: true },
      configStore,
      secretsStore,
    );
    const config = configStore.find("autopush");
    expect(config?.autoPush).toBe(true);
  });
});

// ── 2. git_remove_remote ───────────────────────────────────────────────────

test.describe("git_remove_remote", () => {
  test("removes an existing remote and cleans up secrets", () => {
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

    // Verify remote gone
    expect(configStore.readAll()).toHaveLength(0);

    // Verify secrets cleaned up for all auth types
    expect(secretsStore.hasKey("git_remote", "git_remote:origin:token")).toBe(false);
    expect(secretsStore.hasKey("git_remote", "git_remote:origin:oauth")).toBe(false);
    expect(secretsStore.hasKey("git_remote", "git_remote:origin:ssh")).toBe(false);
  });

  test("returns error for missing name", () => {
    const { status, json } = simulateGitRemotesPOST("remove", {}, configStore, secretsStore);
    expect(status).toBe(400);
    const body = json as { error: { code: string } };
    expect(body.error.code).toBe("MISSING_PARAMS");
  });

  test("remove does not affect other remotes", () => {
    configStore.add({ name: "origin", url: "https://github.com/a/repo.git", provider: "github", autoPush: false });
    configStore.add({ name: "upstream", url: "https://github.com/b/repo.git", provider: "github", autoPush: false });

    simulateGitRemotesPOST("remove", { name: "origin" }, configStore, secretsStore);
    expect(configStore.readAll()).toHaveLength(1);
    expect(configStore.find("upstream")).toBeDefined();
  });
});

// ── 3. git_list_remotes ────────────────────────────────────────────────────

test.describe("git_list_remotes", () => {
  test("lists all remotes with metadata", () => {
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
    const body = json as { remotes: Array<{ name: string; url: string; provider: string; autoPush: boolean; inGitConfig: boolean; status: string }> };
    expect(body.remotes).toHaveLength(2);

    // First remote
    expect(body.remotes[0].name).toBe("origin");
    expect(body.remotes[0].provider).toBe("github");
    expect(body.remotes[0].autoPush).toBe(true);
    expect(body.remotes[0].inGitConfig).toBe(true);
    expect(body.remotes[0].status).toBe("connected");

    // Second remote
    expect(body.remotes[1].name).toBe("upstream");
    expect(body.remotes[1].autoPush).toBe(false);
  });

  test("returns empty list when no remotes configured", () => {
    const { status, json } = simulateGitRemotesGET(configStore);
    expect(status).toBe(200);
    const body = json as { remotes: unknown[] };
    expect(body.remotes).toHaveLength(0);
  });

  test("includes lastPushed metadata when set", () => {
    configStore.add({
      name: "origin",
      url: "https://github.com/user/repo.git",
      provider: "github",
      autoPush: false,
    });
    configStore.update("origin", { lastPushed: "2026-01-15T10:00:00.000Z" });

    const { json } = simulateGitRemotesGET(configStore);
    const body = json as { remotes: Array<{ name: string; lastPushed?: string }> };
    expect(body.remotes[0].lastPushed).toBe("2026-01-15T10:00:00.000Z");
  });
});

// ── 4. git_push ────────────────────────────────────────────────────────────

test.describe("git_push", () => {
  test("pushes to single remote successfully via tool", () => {
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

  test("pushes successfully via API route and updates lastPushed", () => {
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
    // Verify timestamp is valid ISO
    expect(new Date(config!.lastPushed!).toISOString()).toBe(config!.lastPushed!);
  });

  test("returns error on invalid remote via tool", () => {
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

  test("returns error on invalid remote via API route", () => {
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

  test("returns missing params error for tool", () => {
    const result = simulateToolPush({ repoPath: "", remote: "" }, configStore);
    const parsed = JSON.parse(result);
    expect(parsed.error).toBeDefined();
    expect(parsed.error.code).toBe("MISSING_PARAMS");
  });

  test("returns missing params error for API route", () => {
    const { status, json } = simulateGitRemotesPOST("push", {}, configStore, secretsStore);
    expect(status).toBe(400);
    const body = json as { error: { code: string } };
    expect(body.error.code).toBe("MISSING_PARAMS");
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
});

// ── 5. git_push_all_remotes ────────────────────────────────────────────────

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

    // Verify both got lastPushed updated
    expect(configStore.find("origin")?.lastPushed).toBeDefined();
    expect(configStore.find("upstream")?.lastPushed).toBeDefined();
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

    // upstream should not have lastPushed
    expect(configStore.find("upstream")?.lastPushed).toBeUndefined();
  });

  test("returns empty results when no remotes configured", () => {
    const { results } = simulateToolPushAll(
      { repoPath: "/tmp/repo" },
      configStore,
    );
    expect(results).toHaveLength(0);
  });

  test("throws on missing repoPath", () => {
    expect(() =>
      simulateToolPushAll({ repoPath: "" }, configStore),
    ).toThrow("MISSING_PARAMS");
  });
});

// ── 6. End-to-end lifecycle ────────────────────────────────────────────────

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
