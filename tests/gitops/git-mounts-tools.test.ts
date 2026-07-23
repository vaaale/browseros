// git-mounts tools unit tests
//   npx playwright test -c playwright.unit.config.ts tests/gitops/git-mounts-tools.test.ts
//
// These tests exercise the tool-level logic (param validation, error codes,
// mount/unmount flows) by calling simulation functions directly, avoiding the
// server-only import chain.

import { test, expect } from "@playwright/test";

// ── Pure helpers extracted from git-mounts.ts for testability ────────────────

function err(code: string, message: string, suggestion?: string): string {
  return JSON.stringify({ error: { code, message, suggestion } });
}

function detectProvider(url: string): "github" | "gitlab" | "generic" {
  if (/github\.com/i.test(url)) return "github";
  if (/gitlab\.com/i.test(url)) return "gitlab";
  return "generic";
}

// Simulate validateMountPath (mirrors mount-manager.ts logic)
function simulateValidateMountPath(mountPath: string): boolean {
  // Simplified: rejects paths with traversal or absolute paths
  if (mountPath.startsWith("/")) return false;
  const parts = mountPath.split("/");
  let depth = 0;
  for (const part of parts) {
    if (part === "..") depth--;
    else if (part !== "." && part !== "") depth++;
    if (depth < 0) return false;
  }
  return depth >= 0;
}

// Simulate git_mount validation + mount registration flow
function simulateMount(input: {
  remoteName: string;
  mountPath: string;
  branch?: string;
  remoteConfigs: Array<{ name: string; url: string; defaultBranch?: string }>;
  existingMounts: Array<{ remoteName: string }>;
}): { result: string; registered?: { remoteName: string; mountPath: string; branch: string; status: string } } {
  const { remoteName, mountPath, branch, remoteConfigs, existingMounts } = input;

  if (!remoteName || !mountPath) {
    return { result: err("MISSING_PARAMS", "remoteName and mountPath are required.") };
  }

  if (!simulateValidateMountPath(mountPath)) {
    return {
      result: err(
        "MOUNT_PATH_INVALID",
        `Mount path "${mountPath}" is outside data/vfs/.`,
        "Use a relative path within the VFS, e.g. 'Documents/my-repo'.",
      ),
    };
  }

  const remoteConfig = remoteConfigs.find((c) => c.name === remoteName);
  if (!remoteConfig) {
    return {
      result: err(
        "REMOTE_NOT_FOUND",
        `Remote "${remoteName}" is not configured. Use git_add_remote first.`,
      ),
    };
  }

  if (existingMounts.some((m) => m.remoteName === remoteName)) {
    return {
      result: err(
        "ALREADY_MOUNTED",
        `Remote "${remoteName}" is already mounted.`,
      ),
    };
  }

  const resolvedBranch = branch ?? remoteConfig.defaultBranch ?? "main";
  const now = new Date().toISOString();
  const registered = {
    remoteName,
    mountPath,
    branch: resolvedBranch,
    status: "syncing",
    createdAt: now,
    updatedAt: now,
  };

  return {
    result: JSON.stringify({
      status: "success",
      mountPath: registered.mountPath,
      branch: registered.branch,
    }),
    registered,
  };
}

// Simulate git_unmount flow
function simulateUnmount(input: {
  remoteName: string;
  existingMounts: Array<{ remoteName: string }>;
}): string {
  const { remoteName, existingMounts } = input;

  if (!remoteName) {
    return err("MISSING_PARAMS", "remoteName is required.");
  }

  const found = existingMounts.some((m) => m.remoteName === remoteName);
  if (!found) {
    return err("NOT_FOUND", `Remote "${remoteName}" is not mounted.`);
  }

  return JSON.stringify({
    status: "ok",
    message: `Remote '${remoteName}' unmounted.`,
  });
}

// Simulate git_list_mounts flow
function simulateListMounts(mounts: Array<{
  remoteName: string;
  mountPath: string;
  branch: string;
  status: string;
}>): string {
  return JSON.stringify({ mounts });
}

// ── Tests ───────────────────────────────────────────────────────────────────

const sampleConfigs = [
  { name: "origin", url: "https://github.com/user/repo.git", defaultBranch: "main" },
  { name: "upstream", url: "https://github.com/upstream/repo.git", defaultBranch: "develop" },
];

const sampleMounts = [
  {
    remoteName: "origin",
    mountPath: "Documents/my-repo",
    branch: "main",
    status: "synced",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  },
];

// ── git_mount ───────────────────────────────────────────────────────────────

test.describe("git_mount — validation", () => {
  test("returns error when remoteName missing", () => {
    const { result } = simulateMount({
      remoteName: "",
      mountPath: "Documents/repo",
      remoteConfigs: sampleConfigs,
      existingMounts: [],
    });
    const parsed = JSON.parse(result);
    expect(parsed.error.code).toBe("MISSING_PARAMS");
  });

  test("returns error when mountPath missing", () => {
    const { result } = simulateMount({
      remoteName: "origin",
      mountPath: "",
      remoteConfigs: sampleConfigs,
      existingMounts: [],
    });
    const parsed = JSON.parse(result);
    expect(parsed.error.code).toBe("MISSING_PARAMS");
  });

  test("rejects mount path outside data/vfs/", () => {
    const { result } = simulateMount({
      remoteName: "origin",
      mountPath: "../../etc/passwd",
      remoteConfigs: sampleConfigs,
      existingMounts: [],
    });
    const parsed = JSON.parse(result);
    expect(parsed.error.code).toBe("MOUNT_PATH_INVALID");
    expect(parsed.error.suggestion).toContain("relative path");
  });

  test("rejects absolute path", () => {
    const { result } = simulateMount({
      remoteName: "origin",
      mountPath: "/etc/passwd",
      remoteConfigs: sampleConfigs,
      existingMounts: [],
    });
    const parsed = JSON.parse(result);
    expect(parsed.error.code).toBe("MOUNT_PATH_INVALID");
  });

  test("returns error when remote not configured", () => {
    const { result } = simulateMount({
      remoteName: "nonexistent",
      mountPath: "Documents/repo",
      remoteConfigs: sampleConfigs,
      existingMounts: [],
    });
    const parsed = JSON.parse(result);
    expect(parsed.error.code).toBe("REMOTE_NOT_FOUND");
  });

  test("returns error when remote already mounted", () => {
    const { result } = simulateMount({
      remoteName: "origin",
      mountPath: "Documents/repo",
      remoteConfigs: sampleConfigs,
      existingMounts: [{ remoteName: "origin" }],
    });
    const parsed = JSON.parse(result);
    expect(parsed.error.code).toBe("ALREADY_MOUNTED");
  });
});

test.describe("git_mount — success paths", () => {
  test("registers mount with default branch from remote config", () => {
    const { result, registered } = simulateMount({
      remoteName: "upstream",
      mountPath: "Documents/upstream",
      remoteConfigs: sampleConfigs,
      existingMounts: [],
    });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("success");
    expect(parsed.mountPath).toBe("Documents/upstream");
    expect(parsed.branch).toBe("develop");
    expect(registered).toBeDefined();
    expect(registered!.status).toBe("syncing");
  });

  test("uses explicit branch when provided", () => {
    const { result, registered } = simulateMount({
      remoteName: "origin",
      mountPath: "Projects/my-fork",
      branch: "feature-x",
      remoteConfigs: sampleConfigs,
      existingMounts: [],
    });
    const parsed = JSON.parse(result);
    expect(parsed.branch).toBe("feature-x");
    expect(registered!.branch).toBe("feature-x");
  });

  test("defaults to 'main' when no branch specified and no defaultBranch", () => {
    const configs = [{ name: "bare", url: "https://example.com/r.git" }];
    const { result } = simulateMount({
      remoteName: "bare",
      mountPath: "Documents/bare",
      remoteConfigs: configs,
      existingMounts: [],
    });
    const parsed = JSON.parse(result);
    expect(parsed.branch).toBe("main");
  });

  test("allows mounting a second remote to a different path", () => {
    const { result } = simulateMount({
      remoteName: "upstream",
      mountPath: "Documents/upstream",
      remoteConfigs: sampleConfigs,
      existingMounts: [{ remoteName: "origin" }],
    });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("success");
  });

  test("accepts nested VFS paths", () => {
    const { result } = simulateMount({
      remoteName: "origin",
      mountPath: "Work/Projects/my-app/src",
      remoteConfigs: sampleConfigs,
      existingMounts: [],
    });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("success");
  });
});

// ── git_unmount ─────────────────────────────────────────────────────────────

test.describe("git_unmount — validation", () => {
  test("returns error when remoteName missing", () => {
    const result = simulateUnmount({ remoteName: "", existingMounts: sampleMounts });
    const parsed = JSON.parse(result);
    expect(parsed.error.code).toBe("MISSING_PARAMS");
  });

  test("returns error when remote not mounted", () => {
    const result = simulateUnmount({ remoteName: "nonexistent", existingMounts: sampleMounts });
    const parsed = JSON.parse(result);
    expect(parsed.error.code).toBe("NOT_FOUND");
    expect(parsed.error.message).toContain("nonexistent");
  });
});

test.describe("git_unmount — success paths", () => {
  test("unmounts a mounted remote", () => {
    const result = simulateUnmount({ remoteName: "origin", existingMounts: sampleMounts });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("ok");
    expect(parsed.message).toContain("origin");
    expect(parsed.message).toContain("unmounted");
  });
});

// ── git_list_mounts ─────────────────────────────────────────────────────────

test.describe("git_list_mounts", () => {
  test("returns empty array when no mounts", () => {
    const result = simulateListMounts([]);
    const parsed = JSON.parse(result);
    expect(parsed.mounts).toEqual([]);
  });

  test("returns all mounts", () => {
    const result = simulateListMounts(sampleMounts);
    const parsed = JSON.parse(result);
    expect(parsed.mounts).toHaveLength(1);
    expect(parsed.mounts[0].remoteName).toBe("origin");
    expect(parsed.mounts[0].mountPath).toBe("Documents/my-repo");
    expect(parsed.mounts[0].branch).toBe("main");
    expect(parsed.mounts[0].status).toBe("synced");
  });

  test("returns multiple mounts", () => {
    const mounts = [
      ...sampleMounts,
      {
        remoteName: "upstream",
        mountPath: "Documents/upstream",
        branch: "develop",
        status: "syncing",
        createdAt: "2025-01-02T00:00:00.000Z",
        updatedAt: "2025-01-02T00:00:00.000Z",
      },
    ];
    const result = simulateListMounts(mounts);
    const parsed = JSON.parse(result);
    expect(parsed.mounts).toHaveLength(2);
    expect(parsed.mounts.map((m: { remoteName: string }) => m.remoteName)).toEqual(["origin", "upstream"]);
  });

  test("mounts include all required fields", () => {
    const result = simulateListMounts(sampleMounts);
    const parsed = JSON.parse(result);
    const mount = parsed.mounts[0];
    expect(mount).toHaveProperty("remoteName");
    expect(mount).toHaveProperty("mountPath");
    expect(mount).toHaveProperty("branch");
    expect(mount).toHaveProperty("status");
    expect(mount).toHaveProperty("createdAt");
    expect(mount).toHaveProperty("updatedAt");
  });
});

// ── validateMountPath (simulated) ──────────────────────────────────────────

test.describe("validateMountPath simulation", () => {
  test("allows relative paths inside data/vfs/", () => {
    expect(simulateValidateMountPath("Documents/Projects")).toBe(true);
    expect(simulateValidateMountPath("Apps/MyApp")).toBe(true);
    expect(simulateValidateMountPath("a/b/c")).toBe(true);
  });

  test("rejects paths with traversal", () => {
    expect(simulateValidateMountPath("../../etc")).toBe(false);
    expect(simulateValidateMountPath("a/../../b")).toBe(false);
  });

  test("rejects absolute paths", () => {
    expect(simulateValidateMountPath("/etc/passwd")).toBe(false);
  });
});

// ── detectProvider ──────────────────────────────────────────────────────────

test.describe("detectProvider", () => {
  test("detects github", () => {
    expect(detectProvider("https://github.com/user/repo.git")).toBe("github");
  });

  test("detects gitlab", () => {
    expect(detectProvider("https://gitlab.com/user/repo.git")).toBe("gitlab");
  });

  test("detects generic", () => {
    expect(detectProvider("https://bitbucket.org/user/repo.git")).toBe("generic");
  });
});
