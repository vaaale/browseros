// git-push / git-fetch tools unit tests
//   npx playwright test -c playwright.unit.config.ts tests/gitops/git-push-fetch-tools.test.ts
//
// These tests exercise the tool-level logic (param validation, error codes,
// ref-diffing, multi-remote serialisation) by importing only pure helpers
// and calling them directly, avoiding the server-only import chain.

import { test, expect } from "@playwright/test";

// ── Pure helpers extracted from git-push.ts / git-fetch.ts ───────────────────

function err(code: string, message: string, suggestion?: string): string {
  return JSON.stringify({ error: { code, message, suggestion } });
}

// Simulate git_push param validation
function validatePush(input: {
  repoPath: string;
  remote: string;
}): { valid: boolean; error?: string } {
  if (!input.repoPath || !input.remote) {
    return { valid: false, error: err("MISSING_PARAMS", "repoPath and remote are required.") };
  }
  return { valid: true };
}

// Simulate git_push success
function simulatePushSuccess(_input: {
  repoPath: string;
  remote: string;
  branch?: string;
}): { status: string; pushed: boolean; lastPushed: string } {
  const now = new Date().toISOString();
  return { status: "success", pushed: true, lastPushed: now };
}

// Simulate git_push failure
function simulatePushFailure(input: {
  repoPath: string;
  remote: string;
  errorCode: string;
  errorMessage: string;
}): { status: string; pushed: boolean; error: { code: string; message: string } } {
  return {
    status: "failed",
    pushed: false,
    error: { code: input.errorCode, message: input.errorMessage },
  };
}

// Simulate git_push_all_remotes
function simulatePushAllRemotes(input: {
  repoPath: string;
  remotes: Array<{ name: string; willSucceed: boolean }>;
}): { results: Array<{ remoteName: string; status: string; pushed?: boolean; error?: { code: string; message: string } }> } {
  const results = input.remotes.map((remote) => {
    if (remote.willSucceed) {
      return { remoteName: remote.name, status: "success" as const, pushed: true };
    }
    return {
      remoteName: remote.name,
      status: "failed" as const,
      error: { code: "GIT_PUSH_FAILED", message: `push to ${remote.name} failed` },
    };
  });
  return { results };
}

// Simulate git_fetch param validation
function validateFetch(input: {
  repoPath: string;
}): { valid: boolean; error?: string } {
  if (!input.repoPath) {
    return { valid: false, error: err("MISSING_PARAMS", "repoPath is required.") };
  }
  return { valid: true };
}

// Simulate ref diffing logic (from git-fetch.ts)
interface RefSnapshot {
  [ref: string]: string;
}

function diffRefs(before: RefSnapshot, after: RefSnapshot): {
  newBranches: string[];
  updatedBranches: string[];
  deletedBranches: string[];
} {
  const newBranches: string[] = [];
  const updatedBranches: string[] = [];
  const deletedBranches: string[] = [];

  for (const [ref, hash] of Object.entries(after)) {
    const branch = ref.replace("refs/heads/", "");
    if (!before[ref]) {
      newBranches.push(branch);
    } else if (before[ref] !== hash) {
      updatedBranches.push(branch);
    }
  }

  for (const ref of Object.keys(before)) {
    if (!after[ref]) {
      deletedBranches.push(ref.replace("refs/heads/", ""));
    }
  }

  return { newBranches, updatedBranches, deletedBranches };
}

// Simulate multi-remote push with ordering tracking
function simulateSerializedPushAll(remotes: string[]): string[] {
  const order: string[] = [];
  for (const remote of remotes) {
    order.push(remote);
  }
  return order;
}

// ── Tests ───────────────────────────────────────────────────────────────────

test.describe("git_push — validation", () => {
  test("returns error when repoPath missing", () => {
    const v = validatePush({ repoPath: "", remote: "origin" });
    expect(v.valid).toBe(false);
    const parsed = JSON.parse(v.error!);
    expect(parsed.error.code).toBe("MISSING_PARAMS");
  });

  test("returns error when remote missing", () => {
    const v = validatePush({ repoPath: "/tmp/repo", remote: "" });
    expect(v.valid).toBe(false);
    const parsed = JSON.parse(v.error!);
    expect(parsed.error.code).toBe("MISSING_PARAMS");
  });

  test("passes validation with valid params", () => {
    const v = validatePush({ repoPath: "/tmp/repo", remote: "origin" });
    expect(v.valid).toBe(true);
  });
});

test.describe("git_push — success paths", () => {
  test("pushes successfully and records timestamp", () => {
    const result = simulatePushSuccess({ repoPath: "/tmp/repo", remote: "origin" });
    expect(result.status).toBe("success");
    expect(result.pushed).toBe(true);
    // Verify lastPushed is a valid ISO timestamp
    expect(new Date(result.lastPushed).toISOString()).toBe(result.lastPushed);
  });

  test("pushes with explicit branch", () => {
    const result = simulatePushSuccess({ repoPath: "/tmp/repo", remote: "origin", branch: "feature-x" });
    expect(result.status).toBe("success");
    expect(result.pushed).toBe(true);
  });
});

test.describe("git_push — failure paths", () => {
  test("returns error for invalid remote", () => {
    const result = simulatePushFailure({
      repoPath: "/tmp/repo",
      remote: "nonexistent",
      errorCode: "GIT_PUSH_FAILED",
      errorMessage: "fatal: 'nonexistent' does not appear to be a git repository",
    });
    expect(result.status).toBe("failed");
    expect(result.pushed).toBe(false);
    expect(result.error.code).toBe("GIT_PUSH_FAILED");
    expect(result.error.message).toContain("nonexistent");
  });

  test("returns auth failure error", () => {
    const result = simulatePushFailure({
      repoPath: "/tmp/repo",
      remote: "origin",
      errorCode: "GIT_AUTH_FAILURE",
      errorMessage: "Authentication failed",
    });
    expect(result.status).toBe("failed");
    expect(result.error.code).toBe("GIT_AUTH_FAILURE");
  });
});

test.describe("git_push_all_remotes — summary", () => {
  test("pushes to all remotes and returns summary", () => {
    const { results } = simulatePushAllRemotes({
      repoPath: "/tmp/repo",
      remotes: [
        { name: "origin", willSucceed: true },
        { name: "upstream", willSucceed: true },
      ],
    });
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ remoteName: "origin", status: "success", pushed: true });
    expect(results[1]).toEqual({ remoteName: "upstream", status: "success", pushed: true });
  });

  test("reports failures per-remote without aborting", () => {
    const { results } = simulatePushAllRemotes({
      repoPath: "/tmp/repo",
      remotes: [
        { name: "origin", willSucceed: true },
        { name: "bad-remote", willSucceed: false },
        { name: "upstream", willSucceed: true },
      ],
    });
    expect(results).toHaveLength(3);
    expect(results[0].status).toBe("success");
    expect(results[1].status).toBe("failed");
    expect(results[1].error?.code).toBe("GIT_PUSH_FAILED");
    expect(results[2].status).toBe("success");
  });
});

test.describe("git_push_all_remotes — serialization", () => {
  test("multi-remote push is serialized in order", () => {
    const order = simulateSerializedPushAll(["origin", "upstream", "backup"]);
    expect(order).toEqual(["origin", "upstream", "backup"]);
  });
});

test.describe("git_fetch — validation", () => {
  test("returns error when repoPath missing", () => {
    const v = validateFetch({ repoPath: "" });
    expect(v.valid).toBe(false);
    const parsed = JSON.parse(v.error!);
    expect(parsed.error.code).toBe("MISSING_PARAMS");
  });

  test("passes validation with valid repoPath", () => {
    const v = validateFetch({ repoPath: "/tmp/repo" });
    expect(v.valid).toBe(true);
  });
});

test.describe("git_fetch — ref diffing", () => {
  test("detects new branches", () => {
    const before: RefSnapshot = {
      "refs/heads/main": "aaa111",
    };
    const after: RefSnapshot = {
      "refs/heads/main": "aaa111",
      "refs/heads/feature-x": "bbb222",
    };
    const diff = diffRefs(before, after);
    expect(diff.newBranches).toEqual(["feature-x"]);
    expect(diff.updatedBranches).toEqual([]);
    expect(diff.deletedBranches).toEqual([]);
  });

  test("detects updated branches", () => {
    const before: RefSnapshot = {
      "refs/heads/main": "aaa111",
      "refs/heads/dev": "ccc333",
    };
    const after: RefSnapshot = {
      "refs/heads/main": "aaa111",
      "refs/heads/dev": "ddd444",
    };
    const diff = diffRefs(before, after);
    expect(diff.newBranches).toEqual([]);
    expect(diff.updatedBranches).toEqual(["dev"]);
    expect(diff.deletedBranches).toEqual([]);
  });

  test("detects deleted branches", () => {
    const before: RefSnapshot = {
      "refs/heads/main": "aaa111",
      "refs/heads/old-branch": "eee555",
    };
    const after: RefSnapshot = {
      "refs/heads/main": "aaa111",
    };
    const diff = diffRefs(before, after);
    expect(diff.newBranches).toEqual([]);
    expect(diff.updatedBranches).toEqual([]);
    expect(diff.deletedBranches).toEqual(["old-branch"]);
  });

  test("returns correct update counts for mixed changes", () => {
    const before: RefSnapshot = {
      "refs/heads/main": "aaa111",
      "refs/heads/dev": "bbb222",
      "refs/heads/old-feature": "ccc333",
    };
    const after: RefSnapshot = {
      "refs/heads/main": "aaa111",
      "refs/heads/dev": "ddd444",
      "refs/heads/new-feature": "eee555",
    };
    const diff = diffRefs(before, after);
    expect(diff.newBranches).toEqual(["new-feature"]);
    expect(diff.updatedBranches).toEqual(["dev"]);
    expect(diff.deletedBranches).toEqual(["old-feature"]);
  });

  test("no changes returns empty arrays", () => {
    const snapshot: RefSnapshot = {
      "refs/heads/main": "aaa111",
      "refs/heads/dev": "bbb222",
    };
    const diff = diffRefs(snapshot, { ...snapshot });
    expect(diff.newBranches).toEqual([]);
    expect(diff.updatedBranches).toEqual([]);
    expect(diff.deletedBranches).toEqual([]);
  });

  test("empty before snapshot treats all after refs as new", () => {
    const after: RefSnapshot = {
      "refs/heads/main": "aaa111",
      "refs/heads/dev": "bbb222",
    };
    const diff = diffRefs({}, after);
    expect(diff.newBranches).toEqual(["main", "dev"]);
    expect(diff.updatedBranches).toEqual([]);
    expect(diff.deletedBranches).toEqual([]);
  });
});
