import { test, expect } from "@playwright/test";
import { _getRepoPath } from "../../src/lib/gitops/sync-status";
import type { SyncStatus } from "../../src/lib/gitops/sync-status";

test.describe("SyncStatus interface shape", () => {
  test("status has all required fields", () => {
    const status: SyncStatus = {
      remoteName: "origin",
      branch: "main",
      localAhead: 0,
      localBehind: 0,
      hasUncommittedChanges: false,
      conflict: null,
      lastFetched: "2025-01-01T00:00:00.000Z",
      lastSynced: "2025-01-01T00:00:00.000Z",
    };
    expect(status.remoteName).toBe("origin");
    expect(status.branch).toBe("main");
    expect(status.localAhead).toBe(0);
    expect(status.localBehind).toBe(0);
    expect(status.hasUncommittedChanges).toBe(false);
    expect(status.conflict).toBeNull();
  });

  test("status allows null conflict", () => {
    const status: SyncStatus = {
      remoteName: "origin",
      branch: "main",
      localAhead: 2,
      localBehind: 1,
      hasUncommittedChanges: true,
      conflict: null,
      lastFetched: null,
      lastSynced: null,
    };
    expect(status.conflict).toBeNull();
  });

  test("status allows boolean conflict", () => {
    const status: SyncStatus = {
      remoteName: "origin",
      branch: "main",
      localAhead: 0,
      localBehind: 0,
      hasUncommittedChanges: false,
      conflict: true,
      lastFetched: null,
      lastSynced: null,
    };
    expect(status.conflict).toBe(true);
  });

  test("status allows null timestamps", () => {
    const status: SyncStatus = {
      remoteName: "origin",
      branch: "main",
      localAhead: 0,
      localBehind: 0,
      hasUncommittedChanges: false,
      conflict: null,
      lastFetched: null,
      lastSynced: null,
    };
    expect(status.lastFetched).toBeNull();
    expect(status.lastSynced).toBeNull();
  });

  test("status tracks ahead/behind counts", () => {
    const status: SyncStatus = {
      remoteName: "origin",
      branch: "develop",
      localAhead: 5,
      localBehind: 3,
      hasUncommittedChanges: true,
      conflict: false,
      lastFetched: "2025-06-01T12:00:00.000Z",
      lastSynced: "2025-06-01T11:00:00.000Z",
    };
    expect(status.localAhead).toBe(5);
    expect(status.localBehind).toBe(3);
    expect(status.hasUncommittedChanges).toBe(true);
  });
});

test.describe("_getRepoPath", () => {
  test("returns a path containing .git-cache and the remote name", () => {
    const repoPath = _getRepoPath("my-repo");
    expect(repoPath).toContain(".git-cache");
    expect(repoPath).toContain("my-repo");
  });

  test("returns different paths for different remote names", () => {
    const path1 = _getRepoPath("repo-a");
    const path2 = _getRepoPath("repo-b");
    expect(path1).not.toBe(path2);
  });

  test("returns consistent paths for same remote name", () => {
    const path1 = _getRepoPath("consistent-repo");
    const path2 = _getRepoPath("consistent-repo");
    expect(path1).toBe(path2);
  });
});
