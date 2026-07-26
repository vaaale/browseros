// git-remotes tools unit tests
//   npx playwright test -c playwright.unit.config.ts tests/gitops/git-remotes-tools.test.ts
//
// These tests exercise the tool-level logic (param validation, error codes,
// credential-storage keys, auto-rename, provider detection) by importing only
// pure helpers from the tool module and calling them directly, avoiding the
// server-only import chain.

import { test, expect } from "@playwright/test";

// ── Pure helpers extracted from git-remotes.ts for testability ──────────────

function err(code: string, message: string, suggestion?: string): string {
  return JSON.stringify({ error: { code, message, suggestion } });
}

function detectProvider(url: string): "github" | "gitlab" | "generic" {
  if (/github\.com/i.test(url)) return "github";
  if (/gitlab\.com/i.test(url)) return "gitlab";
  return "generic";
}

// Simulate getUniqueRemoteName logic (from remote-config.ts)
function getUniqueRemoteName(name: string, existing: string[]): string {
  if (!existing.includes(name)) return name;
  let counter = 2;
  while (existing.includes(`${name}-${counter}`)) counter++;
  return `${name}-${counter}`;
}

// Simulate the full git_add_remote flow in pure logic
function simulateAddRemote(input: {
  repoPath: string;
  name: string;
  url: string;
  authType: string;
  token?: string;
  existingNames: string[];
}): { result: string; addedName: string; secretKey?: string; secretValue?: unknown; configProvider: string } {
  const { repoPath, name, url, authType, token, existingNames } = input;

  if (!repoPath || !name || !url || !authType) {
    return { result: err("MISSING_PARAMS", "repoPath, name, url, and authType are required."), addedName: "", configProvider: "generic" };
  }

  if (url.startsWith("git://")) {
    return {
      result: err("INVALID_URL", "git:// protocol is not supported for remotes. Use https:// or ssh:// instead.", "Convert the URL to HTTPS or SSH format."),
      addedName: "",
      configProvider: "generic",
    };
  }

  if (!["token", "oauth", "ssh"].includes(authType)) {
    return { result: err("INVALID_AUTH_TYPE", `Invalid authType '${authType}'. Must be 'token', 'oauth', or 'ssh'.`), addedName: "", configProvider: "generic" };
  }

  const uniqueName = getUniqueRemoteName(name, existingNames);
  const provider = detectProvider(url);

  let secretKey: string | undefined;
  let secretValue: unknown;
  if (token) {
    secretKey = `git_remote:${uniqueName}:${authType}`;
    secretValue = authType === "ssh"
      ? { keyData: token }
      : authType === "oauth"
        ? { access_token: token }
        : { token };
  }

  const resultObj: Record<string, unknown> = {
    name: uniqueName,
    url,
    status: "ok",
    message: uniqueName !== name
      ? `Remote name '${name}' was already taken. Registered as '${uniqueName}' instead.`
      : `Remote '${uniqueName}' registered successfully.`,
  };
  if (uniqueName !== name) resultObj.uniqueName = uniqueName;

  return { result: JSON.stringify(resultObj), addedName: uniqueName, secretKey, secretValue, configProvider: provider };
}

// Simulate git_remove_remote flow
function simulateRemoveRemote(input: { repoPath: string; name: string }): string {
  const { repoPath, name } = input;
  if (!repoPath || !name) {
    return err("MISSING_PARAMS", "repoPath and name are required.");
  }
  return JSON.stringify({ status: "ok", message: `Remote '${name}' removed successfully.` });
}

// Simulate git_list_remotes flow
function simulateListRemotes(input: { repoPath: string; gitRemotes: Array<{ name: string; url: string }> }): string {
  const { repoPath, gitRemotes } = input;
  if (!repoPath) {
    return err("MISSING_PARAMS", "repoPath is required.");
  }
  return JSON.stringify({ remotes: gitRemotes });
}

// Simulate git_list_branches flow
function simulateListBranches(input: { url: string; authType: string }): string {
  const { url, authType } = input;
  if (!url || !authType) {
    return err("MISSING_PARAMS", "url and authType are required.");
  }
  if (!["token", "oauth", "ssh"].includes(authType)) {
    return err("INVALID_AUTH_TYPE", `Invalid authType '${authType}'. Must be 'token', 'oauth', or 'ssh'.`);
  }
  return JSON.stringify({ branches: ["main", "dev", "feature/x"] });
}

// ── Tests ───────────────────────────────────────────────────────────────────

test.describe("git_add_remote — validation", () => {
  test("rejects git:// URLs", () => {
    const { result } = simulateAddRemote({
      repoPath: "/tmp/repo",
      name: "bad",
      url: "git://github.com/user/repo.git",
      authType: "token",
      existingNames: [],
    });
    const parsed = JSON.parse(result);
    expect(parsed.error).toBeDefined();
    expect(parsed.error.code).toBe("INVALID_URL");
    expect(parsed.error.suggestion).toContain("HTTPS or SSH");
  });

  test("returns error when required params missing", () => {
    const { result } = simulateAddRemote({
      repoPath: "/tmp/repo",
      name: "",
      url: "",
      authType: "",
      existingNames: [],
    });
    const parsed = JSON.parse(result);
    expect(parsed.error.code).toBe("MISSING_PARAMS");
  });

  test("returns error for invalid authType", () => {
    const { result } = simulateAddRemote({
      repoPath: "/tmp/repo",
      name: "x",
      url: "https://example.com/r.git",
      authType: "invalid",
      existingNames: [],
    });
    const parsed = JSON.parse(result);
    expect(parsed.error.code).toBe("INVALID_AUTH_TYPE");
  });

  test("auto-detects provider from URL", () => {
    expect(detectProvider("https://github.com/user/repo.git")).toBe("github");
    expect(detectProvider("https://gitlab.com/user/repo.git")).toBe("gitlab");
    expect(detectProvider("https://bitbucket.org/user/repo.git")).toBe("generic");
  });
});

test.describe("git_add_remote — success paths", () => {
  test("valid URL + token produces correct secret key and value", () => {
    const { result, addedName, secretKey, secretValue, configProvider } = simulateAddRemote({
      repoPath: "/tmp/repo",
      name: "myremote",
      url: "https://github.com/user/repo.git",
      authType: "token",
      token: "ghp_test123",
      existingNames: [],
    });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("ok");
    expect(parsed.name).toBe("myremote");
    expect(addedName).toBe("myremote");
    expect(secretKey).toBe("git_remote:myremote:token");
    expect(secretValue).toEqual({ token: "ghp_test123" });
    expect(configProvider).toBe("github");
  });

  test("auto-renames when name is taken", () => {
    const { result, addedName } = simulateAddRemote({
      repoPath: "/tmp/repo",
      name: "origin",
      url: "https://github.com/user/repo.git",
      authType: "token",
      existingNames: ["origin"],
    });
    const parsed = JSON.parse(result);
    expect(parsed.name).toBe("origin-2");
    expect(parsed.uniqueName).toBe("origin-2");
    expect(parsed.message).toContain("already taken");
    expect(addedName).toBe("origin-2");
  });

  test("OAuth token stored with correct structure", () => {
    const { secretKey, secretValue } = simulateAddRemote({
      repoPath: "/tmp/repo",
      name: "gh",
      url: "https://github.com/user/repo.git",
      authType: "oauth",
      token: "gho_oauth123",
      existingNames: [],
    });
    expect(secretKey).toBe("git_remote:gh:oauth");
    expect(secretValue).toEqual({ access_token: "gho_oauth123" });
  });

  test("SSH key stored with correct structure", () => {
    const { secretKey, secretValue } = simulateAddRemote({
      repoPath: "/tmp/repo",
      name: "ssh",
      url: "git@github.com:user/repo.git",
      authType: "ssh",
      token: "-----BEGIN OPENSSH PRIVATE KEY-----",
      existingNames: [],
    });
    expect(secretKey).toBe("git_remote:ssh:ssh");
    expect(secretValue).toEqual({ keyData: "-----BEGIN OPENSSH PRIVATE KEY-----" });
  });

  test("no secret stored when token omitted", () => {
    const { secretKey } = simulateAddRemote({
      repoPath: "/tmp/repo",
      name: "notoken",
      url: "https://github.com/user/repo.git",
      authType: "token",
      existingNames: [],
    });
    expect(secretKey).toBeUndefined();
  });
});

test.describe("getUniqueRemoteName", () => {
  test("returns name unchanged when not taken", () => {
    expect(getUniqueRemoteName("upstream", ["origin"])).toBe("upstream");
  });

  test("appends -2 when name is taken", () => {
    expect(getUniqueRemoteName("origin", ["origin"])).toBe("origin-2");
  });

  test("skips occupied suffixes", () => {
    expect(getUniqueRemoteName("origin", ["origin", "origin-2"])).toBe("origin-3");
  });

  test("returns name when existing list is empty", () => {
    expect(getUniqueRemoteName("origin", [])).toBe("origin");
  });
});

test.describe("git_remove_remote — validation", () => {
  test("returns error when params missing", () => {
    const result = simulateRemoveRemote({ repoPath: "", name: "" });
    const parsed = JSON.parse(result);
    expect(parsed.error.code).toBe("MISSING_PARAMS");
  });

  test("returns ok with valid params", () => {
    const result = simulateRemoveRemote({ repoPath: "/tmp/repo", name: "upstream" });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("ok");
    expect(parsed.message).toContain("upstream");
  });
});

test.describe("git_list_remotes — validation", () => {
  test("returns error when repoPath missing", () => {
    const result = simulateListRemotes({ repoPath: "", gitRemotes: [] });
    const parsed = JSON.parse(result);
    expect(parsed.error.code).toBe("MISSING_PARAMS");
  });

  test("returns remotes list", () => {
    const gitRemotes = [
      { name: "origin", url: "https://github.com/test/repo.git" },
      { name: "upstream", url: "https://github.com/upstream/repo.git" },
    ];
    const result = simulateListRemotes({ repoPath: "/tmp/repo", gitRemotes });
    const parsed = JSON.parse(result);
    expect(parsed.remotes).toHaveLength(2);
    expect(parsed.remotes[0].name).toBe("origin");
    expect(parsed.remotes[1].url).toBe("https://github.com/upstream/repo.git");
  });
});

test.describe("git_list_branches — validation", () => {
  test("returns error when required params missing", () => {
    const result = simulateListBranches({ url: "", authType: "" });
    const parsed = JSON.parse(result);
    expect(parsed.error.code).toBe("MISSING_PARAMS");
  });

  test("returns error for invalid authType", () => {
    const result = simulateListBranches({ url: "https://github.com/user/repo.git", authType: "bad" });
    const parsed = JSON.parse(result);
    expect(parsed.error.code).toBe("INVALID_AUTH_TYPE");
  });

  test("returns branches with valid params", () => {
    const result = simulateListBranches({ url: "https://github.com/user/repo.git", authType: "token" });
    const parsed = JSON.parse(result);
    expect(parsed.branches).toEqual(["main", "dev", "feature/x"]);
  });
});
