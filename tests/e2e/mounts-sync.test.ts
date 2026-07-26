// VFS Mounts & Sync — E2E tests for mount operations and sync status.
//
//   npx playwright test -c playwright.unit.config.ts tests/e2e/mounts-sync.spec.ts
//
// These tests exercise mount CRUD, sync status computation, conflict
// detection, and mount lifecycle by simulating the mount-manager,
// sync-status, and git-ops logic with in-memory stores.  Git child_process
// calls are never executed.

import { test, expect } from "@playwright/test";

// ── Helpers ─────────────────────────────────────────────────────────────────

function err(code: string, message: string, suggestion?: string) {
  return suggestion
    ? { error: { code, message, suggestion } }
    : { error: { code, message } };
}

// ── Simulated Mount Store (in-memory, mirrors mount-manager.ts) ─────────────

interface GitMountConfig {
  remoteName: string;
  mountPath: string;
  branch: string;
  status: "synced" | "syncing" | "error";
  lastSynced?: string;
  createdAt: string;
  updatedAt: string;
}

class SimMountStore {
  private mounts: GitMountConfig[] = [];

  validateMountPath(mountPath: string): boolean {
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

  mountRepo(remoteName: string, mountPath: string, branch: string = "main"): GitMountConfig {
    if (!this.validateMountPath(mountPath)) {
      throw new Error(`Mount path "${mountPath}" is outside data/vfs/`);
    }
    if (this.mounts.find((m) => m.remoteName === remoteName)) {
      throw new Error(`Remote "${remoteName}" is already mounted`);
    }
    const now = new Date().toISOString();
    const config: GitMountConfig = {
      remoteName,
      mountPath,
      branch,
      status: "syncing",
      createdAt: now,
      updatedAt: now,
    };
    this.mounts.push(config);
    return config;
  }

  unmountRepo(remoteName: string): boolean {
    const idx = this.mounts.findIndex((m) => m.remoteName === remoteName);
    if (idx === -1) return false;
    this.mounts.splice(idx, 1);
    return true;
  }

  listMounts(): GitMountConfig[] {
    return [...this.mounts];
  }

  getMountStatus(remoteName: string): GitMountConfig | null {
    return this.mounts.find((m) => m.remoteName === remoteName) ?? null;
  }

  updateMountStatus(remoteName: string, status: "syncing" | "error" | "synced"): void {
    const mount = this.mounts.find((m) => m.remoteName === remoteName);
    if (!mount) return;
    mount.status = status;
    mount.updatedAt = new Date().toISOString();
    if (status === "synced") mount.lastSynced = new Date().toISOString();
  }

  clear(): void {
    this.mounts = [];
  }
}

// ── Simulated Git Backend (mocked spawn) ────────────────────────────────────

interface GitCall {
  args: string[];
  cwd?: string;
}

class SimGitBackend {
  private calls: GitCall[] = [];
  private aheadBehindResult = { ahead: 0, behind: 0 };
  private uncommittedResult = false;
  private fetchError = false;
  private conflictResult: "clean" | "conflict" = "clean";

  reset(): void {
    this.calls = [];
    this.aheadBehindResult = { ahead: 0, behind: 0 };
    this.uncommittedResult = false;
    this.fetchError = false;
    this.conflictResult = "clean";
  }

  setAheadBehind(ahead: number, behind: number): void {
    this.aheadBehindResult = { ahead, behind };
  }

  setUncommittedChanges(hasChanges: boolean): void {
    this.uncommittedResult = hasChanges;
  }

  setFetchError(shouldError: boolean): void {
    this.fetchError = shouldError;
  }

  setConflictResult(result: "clean" | "conflict"): void {
    this.conflictResult = result;
  }

  getCalls(): GitCall[] {
    return [...this.calls];
  }

  async fetchRepo(_repoPath: string, _remote: string, _branch: string): Promise<{ ahead: number; behind: number }> {
    this.calls.push({ args: ["fetch", _remote, _branch], cwd: _repoPath });
    if (this.fetchError) throw new Error("fetch failed");
    return this.aheadBehindResult;
  }

  async hasUncommittedChanges(_repoPath: string): Promise<boolean> {
    this.calls.push({ args: ["status", "--porcelain"], cwd: _repoPath });
    return this.uncommittedResult;
  }

  async checkConflict(repoPath: string, branch: string): Promise<boolean> {
    this.calls.push({ args: ["merge", "--no-commit", "--no-ff", `origin/${branch}`], cwd: repoPath });
    // Always abort the merge attempt
    this.calls.push({ args: ["merge", "--abort"], cwd: repoPath });
    return this.conflictResult === "conflict";
  }
}

// ── Simulated Sync Status (mirrors sync-status.ts logic) ────────────────────

interface SyncStatus {
  remoteName: string;
  branch: string;
  localAhead: number;
  localBehind: number;
  hasUncommittedChanges: boolean;
  conflict: boolean | null;
  lastFetched: string | null;
  lastSynced: string | null;
}

async function simulateGetSyncStatus(
  remoteName: string,
  mountStore: SimMountStore,
  gitBackend: SimGitBackend,
): Promise<SyncStatus> {
  const mount = mountStore.getMountStatus(remoteName);
  if (!mount) throw new Error(`Remote "${remoteName}" is not mounted`);

  let localAhead = 0;
  let localBehind = 0;
  let lastFetched: string | null = null;

  try {
    const ab = await gitBackend.fetchRepo("", "origin", mount.branch);
    localAhead = ab.ahead;
    localBehind = ab.behind;
    lastFetched = new Date().toISOString();
  } catch {
    // Fetch failed — proceed with zeros.
  }

  let uncommitted = false;
  try {
    uncommitted = await gitBackend.hasUncommittedChanges("");
  } catch {
    // Not a git repo — assume no changes.
  }

  return {
    remoteName,
    branch: mount.branch,
    localAhead,
    localBehind,
    hasUncommittedChanges: uncommitted,
    conflict: null,
    lastFetched,
    lastSynced: mount.lastSynced ?? null,
  };
}

async function simulateHasConflict(
  remoteName: string,
  mountStore: SimMountStore,
  gitBackend: SimGitBackend,
): Promise<boolean> {
  const mount = mountStore.getMountStatus(remoteName);
  if (!mount) throw new Error(`Remote "${remoteName}" is not mounted`);
  return gitBackend.checkConflict("", mount.branch);
}

async function simulateResolveConflict(
  remoteName: string,
  strategy: "merge" | "rebase",
  mountStore: SimMountStore,
  gitBackend: SimGitBackend,
): Promise<void> {
  const mount = mountStore.getMountStatus(remoteName);
  if (!mount) throw new Error(`Remote "${remoteName}" is not mounted`);
  const args = strategy === "rebase"
    ? ["rebase", `origin/${mount.branch}`]
    : ["merge", `origin/${mount.branch}`];
  gitBackend.getCalls(); // trigger side-effect-free access
  // In a real implementation this would run git — we just record the call shape.
  void args;
}

// ── Simulated Tool: git_mount ───────────────────────────────────────────────

function simulateToolMount(
  input: { remoteName: string; mountPath: string; branch?: string },
  mountStore: SimMountStore,
  remoteConfigs: Array<{ name: string; url: string; defaultBranch?: string }>,
): string {
  const remoteName = String(input.remoteName ?? "").trim();
  const mountPath = String(input.mountPath ?? "").trim();

  if (!remoteName || !mountPath) {
    return JSON.stringify(err("MISSING_PARAMS", "remoteName and mountPath are required."));
  }

  if (!mountStore.validateMountPath(mountPath)) {
    return JSON.stringify(err(
      "MOUNT_PATH_INVALID",
      `Mount path "${mountPath}" is outside data/vfs/.`,
      "Use a relative path within the VFS, e.g. 'Documents/my-repo'.",
    ));
  }

  const remoteConfig = remoteConfigs.find((c) => c.name === remoteName);
  if (!remoteConfig) {
    return JSON.stringify(err("REMOTE_NOT_FOUND", `Remote "${remoteName}" is not configured.`));
  }

  try {
    const config = mountStore.mountRepo(remoteName, mountPath, input.branch ?? remoteConfig.defaultBranch ?? "main");
    return JSON.stringify({
      status: "success",
      mountPath: config.mountPath,
      branch: config.branch,
    });
  } catch (e) {
    const msg = (e as Error).message;
    const code = msg.includes("already mounted") ? "ALREADY_MOUNTED" : "MOUNT_FAILED";
    return JSON.stringify(err(code, msg));
  }
}

// ── Simulated Tool: git_unmount ─────────────────────────────────────────────

function simulateToolUnmount(
  input: { remoteName: string },
  mountStore: SimMountStore,
): string {
  const remoteName = String(input.remoteName ?? "").trim();
  if (!remoteName) {
    return JSON.stringify(err("MISSING_PARAMS", "remoteName is required."));
  }
  const success = mountStore.unmountRepo(remoteName);
  if (!success) {
    return JSON.stringify(err("NOT_FOUND", `Remote "${remoteName}" is not mounted.`));
  }
  return JSON.stringify({ status: "ok", message: `Remote '${remoteName}' unmounted.` });
}

// ── Simulated Tool: git_list_mounts ─────────────────────────────────────────

function simulateToolListMounts(mountStore: SimMountStore): string {
  return JSON.stringify({ mounts: mountStore.listMounts() });
}

// ════════════════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════════════════

let mountStore: SimMountStore;
let gitBackend: SimGitBackend;
const remoteConfigs = [
  { name: "origin", url: "https://github.com/user/repo.git", defaultBranch: "main" },
  { name: "upstream", url: "https://github.com/upstream/repo.git", defaultBranch: "develop" },
];

test.beforeEach(() => {
  mountStore = new SimMountStore();
  gitBackend = new SimGitBackend();
});

// ── 1. Mount operations ────────────────────────────────────────────────────

test.describe("mount operations", () => {
  test("mounts a remote to a VFS path via tool", () => {
    const result = simulateToolMount(
      { remoteName: "origin", mountPath: "Documents/my-repo" },
      mountStore,
      remoteConfigs,
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("success");
    expect(parsed.mountPath).toBe("Documents/my-repo");
    expect(parsed.branch).toBe("main");

    // Verify mount is in the store
    const status = mountStore.getMountStatus("origin");
    expect(status).not.toBeNull();
    expect(status!.mountPath).toBe("Documents/my-repo");
    expect(status!.status).toBe("syncing");
  });

  test("mounts a remote with explicit branch", () => {
    const result = simulateToolMount(
      { remoteName: "origin", mountPath: "Documents/my-repo", branch: "feature-x" },
      mountStore,
      remoteConfigs,
    );
    const parsed = JSON.parse(result);
    expect(parsed.branch).toBe("feature-x");

    const status = mountStore.getMountStatus("origin");
    expect(status!.branch).toBe("feature-x");
  });

  test("mounts a remote with default branch from config", () => {
    const result = simulateToolMount(
      { remoteName: "upstream", mountPath: "Documents/upstream" },
      mountStore,
      remoteConfigs,
    );
    const parsed = JSON.parse(result);
    expect(parsed.branch).toBe("develop");
  });

  test("lists all mounts", () => {
    mountStore.mountRepo("origin", "Documents/repo-1", "main");
    mountStore.mountRepo("upstream", "Documents/repo-2", "develop");

    const result = simulateToolListMounts(mountStore);
    const parsed = JSON.parse(result);
    expect(parsed.mounts).toHaveLength(2);
    expect(parsed.mounts[0].remoteName).toBe("origin");
    expect(parsed.mounts[1].remoteName).toBe("upstream");
  });

  test("lists empty array when no mounts", () => {
    const result = simulateToolListMounts(mountStore);
    const parsed = JSON.parse(result);
    expect(parsed.mounts).toHaveLength(0);
  });

  test("unmounts a remote via tool", () => {
    mountStore.mountRepo("origin", "Documents/repo");

    const result = simulateToolUnmount({ remoteName: "origin" }, mountStore);
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("ok");
    expect(parsed.message).toContain("origin");
    expect(parsed.message).toContain("unmounted");

    expect(mountStore.getMountStatus("origin")).toBeNull();
  });

  test("returns NOT_FOUND when unmounting non-existent remote", () => {
    const result = simulateToolUnmount({ remoteName: "nonexistent" }, mountStore);
    const parsed = JSON.parse(result);
    expect(parsed.error.code).toBe("NOT_FOUND");
  });

  test("validates mount path is within data/vfs/", () => {
    expect(mountStore.validateMountPath("Documents/Projects")).toBe(true);
    expect(mountStore.validateMountPath("Apps/MyApp")).toBe(true);
    expect(mountStore.validateMountPath("a/b/c")).toBe(true);
  });

  test("rejects path outside data/vfs/", () => {
    expect(mountStore.validateMountPath("../../etc/passwd")).toBe(false);
    expect(mountStore.validateMountPath("../config")).toBe(false);
  });

  test("rejects absolute path", () => {
    expect(mountStore.validateMountPath("/etc/passwd")).toBe(false);
  });

  test("rejects path with traversal", () => {
    expect(mountStore.validateMountPath("Documents/../../../etc")).toBe(false);
    expect(mountStore.validateMountPath("a/../../b")).toBe(false);
  });

  test("gets mount status for mounted remote", () => {
    mountStore.mountRepo("origin", "Documents/repo", "main");
    const status = mountStore.getMountStatus("origin");
    expect(status).not.toBeNull();
    expect(status!.remoteName).toBe("origin");
    expect(status!.mountPath).toBe("Documents/repo");
    expect(status!.branch).toBe("main");
    expect(status!.status).toBe("syncing");
  });

  test("returns null for unmounted remote", () => {
    expect(mountStore.getMountStatus("nonexistent")).toBeNull();
  });

  test("updates mount status", () => {
    mountStore.mountRepo("origin", "Documents/repo");

    mountStore.updateMountStatus("origin", "synced");
    const status = mountStore.getMountStatus("origin");
    expect(status!.status).toBe("synced");
    expect(status!.lastSynced).toBeDefined();

    mountStore.updateMountStatus("origin", "error");
    const errorStatus = mountStore.getMountStatus("origin");
    expect(errorStatus!.status).toBe("error");

    mountStore.updateMountStatus("origin", "syncing");
    const syncingStatus = mountStore.getMountStatus("origin");
    expect(syncingStatus!.status).toBe("syncing");
  });

  test("does nothing when updating status of non-existent remote", () => {
    // Should not throw
    mountStore.updateMountStatus("nonexistent", "synced");
    expect(mountStore.getMountStatus("nonexistent")).toBeNull();
  });

  test("rejects mount with invalid path via tool", () => {
    const result = simulateToolMount(
      { remoteName: "origin", mountPath: "../../etc/passwd" },
      mountStore,
      remoteConfigs,
    );
    const parsed = JSON.parse(result);
    expect(parsed.error.code).toBe("MOUNT_PATH_INVALID");
    expect(parsed.error.suggestion).toContain("relative path");
  });

  test("rejects already-mounted remote", () => {
    mountStore.mountRepo("origin", "Documents/repo");

    const result = simulateToolMount(
      { remoteName: "origin", mountPath: "Documents/other" },
      mountStore,
      remoteConfigs,
    );
    const parsed = JSON.parse(result);
    expect(parsed.error.code).toBe("ALREADY_MOUNTED");
  });

  test("rejects mount for unconfigured remote", () => {
    const result = simulateToolMount(
      { remoteName: "nonexistent", mountPath: "Documents/repo" },
      mountStore,
      remoteConfigs,
    );
    const parsed = JSON.parse(result);
    expect(parsed.error.code).toBe("REMOTE_NOT_FOUND");
  });
});

// ── 2. Sync status ─────────────────────────────────────────────────────────

test.describe("sync status", () => {
  test("computes ahead/behind counts", async () => {
    mountStore.mountRepo("origin", "Documents/repo", "main");
    gitBackend.setAheadBehind(3, 5);

    const status = await simulateGetSyncStatus("origin", mountStore, gitBackend);
    expect(status.localAhead).toBe(3);
    expect(status.localBehind).toBe(5);
    expect(status.branch).toBe("main");
    expect(status.lastFetched).not.toBeNull();
  });

  test("returns zero counts when in sync", async () => {
    mountStore.mountRepo("origin", "Documents/repo", "main");
    gitBackend.setAheadBehind(0, 0);

    const status = await simulateGetSyncStatus("origin", mountStore, gitBackend);
    expect(status.localAhead).toBe(0);
    expect(status.localBehind).toBe(0);
  });

  test("detects uncommitted changes", async () => {
    mountStore.mountRepo("origin", "Documents/repo", "main");
    gitBackend.setUncommittedChanges(true);

    const status = await simulateGetSyncStatus("origin", mountStore, gitBackend);
    expect(status.hasUncommittedChanges).toBe(true);
  });

  test("reports no uncommitted changes when clean", async () => {
    mountStore.mountRepo("origin", "Documents/repo", "main");
    gitBackend.setUncommittedChanges(false);

    const status = await simulateGetSyncStatus("origin", mountStore, gitBackend);
    expect(status.hasUncommittedChanges).toBe(false);
  });

  test("detects conflict", async () => {
    mountStore.mountRepo("origin", "Documents/repo", "main");
    gitBackend.setConflictResult("conflict");

    const hasConflict = await simulateHasConflict("origin", mountStore, gitBackend);
    expect(hasConflict).toBe(true);
  });

  test("reports no conflict when clean", async () => {
    mountStore.mountRepo("origin", "Documents/repo", "main");
    gitBackend.setConflictResult("clean");

    const hasConflict = await simulateHasConflict("origin", mountStore, gitBackend);
    expect(hasConflict).toBe(false);
  });

  test("sync status for non-conflicted remote has null conflict", async () => {
    mountStore.mountRepo("origin", "Documents/repo", "main");
    gitBackend.setAheadBehind(1, 0);
    gitBackend.setConflictResult("clean");

    const status = await simulateGetSyncStatus("origin", mountStore, gitBackend);
    expect(status.conflict).toBeNull();
    expect(status.localAhead).toBe(1);
    expect(status.localBehind).toBe(0);
  });

  test("throws when getting sync status for non-mounted remote", async () => {
    await expect(
      simulateGetSyncStatus("nonexistent", mountStore, gitBackend),
    ).rejects.toThrow('not mounted');
  });

  test("throws when checking conflict for non-mounted remote", async () => {
    await expect(
      simulateHasConflict("nonexistent", mountStore, gitBackend),
    ).rejects.toThrow('not mounted');
  });

  test("handles fetch failure gracefully", async () => {
    mountStore.mountRepo("origin", "Documents/repo", "main");
    gitBackend.setFetchError(true);

    const status = await simulateGetSyncStatus("origin", mountStore, gitBackend);
    expect(status.localAhead).toBe(0);
    expect(status.localBehind).toBe(0);
    expect(status.lastFetched).toBeNull();
  });

  test("passes lastSynced from mount config", async () => {
    mountStore.mountRepo("origin", "Documents/repo", "main");
    // Simulate a previous sync
    mountStore.updateMountStatus("origin", "synced");

    const status = await simulateGetSyncStatus("origin", mountStore, gitBackend);
    expect(status.lastSynced).not.toBeNull();
  });
});

// ── 3. Mount lifecycle ─────────────────────────────────────────────────────

test.describe("mount lifecycle", () => {
  test("full mount → sync → unmount lifecycle", async () => {
    // Mount
    const mountResult = simulateToolMount(
      { remoteName: "origin", mountPath: "Documents/my-repo" },
      mountStore,
      remoteConfigs,
    );
    expect(JSON.parse(mountResult).status).toBe("success");

    let status = mountStore.getMountStatus("origin");
    expect(status).not.toBeNull();
    expect(status!.status).toBe("syncing");

    // Sync
    gitBackend.setAheadBehind(0, 0);
    const syncStatus = await simulateGetSyncStatus("origin", mountStore, gitBackend);
    expect(syncStatus.localAhead).toBe(0);
    expect(syncStatus.localBehind).toBe(0);

    // Mark as synced
    mountStore.updateMountStatus("origin", "synced");
    status = mountStore.getMountStatus("origin");
    expect(status!.status).toBe("synced");
    expect(status!.lastSynced).toBeDefined();

    // Unmount
    const unmountResult = simulateToolUnmount({ remoteName: "origin" }, mountStore);
    expect(JSON.parse(unmountResult).status).toBe("ok");
    expect(mountStore.getMountStatus("origin")).toBeNull();
  });

  test("mount with invalid path is rejected", () => {
    const result = simulateToolMount(
      { remoteName: "origin", mountPath: "../../etc/passwd" },
      mountStore,
      remoteConfigs,
    );
    const parsed = JSON.parse(result);
    expect(parsed.error.code).toBe("MOUNT_PATH_INVALID");

    // Nothing should be mounted
    expect(mountStore.listMounts()).toHaveLength(0);
  });

  test("multiple mounts on same repo with different paths", () => {
    // Mount origin to path A
    const result1 = simulateToolMount(
      { remoteName: "origin", mountPath: "Documents/repo-a" },
      mountStore,
      remoteConfigs,
    );
    expect(JSON.parse(result1).status).toBe("success");

    // Cannot mount same remote again (ALREADY_MOUNTED)
    const result2 = simulateToolMount(
      { remoteName: "origin", mountPath: "Documents/repo-b" },
      mountStore,
      remoteConfigs,
    );
    expect(JSON.parse(result2).error.code).toBe("ALREADY_MOUNTED");

    // Only one mount exists
    expect(mountStore.listMounts()).toHaveLength(1);

    // But a different remote can be mounted
    const result3 = simulateToolMount(
      { remoteName: "upstream", mountPath: "Documents/upstream" },
      mountStore,
      remoteConfigs,
    );
    expect(JSON.parse(result3).status).toBe("success");
    expect(mountStore.listMounts()).toHaveLength(2);
  });

  test("mount → sync with changes → unmount", async () => {
    // Mount
    simulateToolMount(
      { remoteName: "origin", mountPath: "Documents/repo" },
      mountStore,
      remoteConfigs,
    );

    // Sync — remote has diverged
    gitBackend.setAheadBehind(2, 3);
    gitBackend.setUncommittedChanges(true);
    const syncStatus = await simulateGetSyncStatus("origin", mountStore, gitBackend);
    expect(syncStatus.localAhead).toBe(2);
    expect(syncStatus.localBehind).toBe(3);
    expect(syncStatus.hasUncommittedChanges).toBe(true);

    // Unmount
    simulateToolUnmount({ remoteName: "origin" }, mountStore);
    expect(mountStore.listMounts()).toHaveLength(0);
  });

  test("mount → conflict detection → unmount", async () => {
    simulateToolMount(
      { remoteName: "origin", mountPath: "Documents/repo" },
      mountStore,
      remoteConfigs,
    );

    gitBackend.setConflictResult("conflict");
    const hasConflict = await simulateHasConflict("origin", mountStore, gitBackend);
    expect(hasConflict).toBe(true);

    simulateToolUnmount({ remoteName: "origin" }, mountStore);
    expect(mountStore.listMounts()).toHaveLength(0);
  });

  test("unmount does not affect other mounts", () => {
    mountStore.mountRepo("origin", "Documents/repo-1", "main");
    mountStore.mountRepo("upstream", "Documents/repo-2", "develop");

    mountStore.unmountRepo("origin");

    expect(mountStore.listMounts()).toHaveLength(1);
    expect(mountStore.getMountStatus("origin")).toBeNull();
    expect(mountStore.getMountStatus("upstream")).not.toBeNull();
  });

  test("status transitions: syncing → synced → error → syncing → synced", () => {
    mountStore.mountRepo("origin", "Documents/repo");
    expect(mountStore.getMountStatus("origin")!.status).toBe("syncing");

    mountStore.updateMountStatus("origin", "synced");
    expect(mountStore.getMountStatus("origin")!.status).toBe("synced");

    mountStore.updateMountStatus("origin", "error");
    expect(mountStore.getMountStatus("origin")!.status).toBe("error");

    mountStore.updateMountStatus("origin", "syncing");
    expect(mountStore.getMountStatus("origin")!.status).toBe("syncing");

    mountStore.updateMountStatus("origin", "synced");
    expect(mountStore.getMountStatus("origin")!.status).toBe("synced");
    expect(mountStore.getMountStatus("origin")!.lastSynced).toBeDefined();
  });
});
