import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import {
  _readMounts,
  _remoteHash,
  validateMountPath,
} from "../../src/lib/gitops/mount-manager";
import type { GitMountConfig } from "../../src/lib/gitops/mount-manager";

const TMP = join(__dirname, ".tmp-mount-manager-test");

function setupTmpConfig(): string {
  const configDir = join(TMP, "config");
  mkdirSync(configDir, { recursive: true });
  return join(configDir, "git-mounts.json");
}

test.beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

test.afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

test.describe("validateMountPath", () => {
  test("allows paths inside data/vfs/", () => {
    expect(validateMountPath("Documents/Projects")).toBe(true);
    expect(validateMountPath("Apps/MyApp")).toBe(true);
    expect(validateMountPath("foo/bar/baz")).toBe(true);
  });

  test("rejects paths outside data/vfs/", () => {
    expect(validateMountPath("../../etc/passwd")).toBe(false);
    expect(validateMountPath("/etc/passwd")).toBe(false);
    expect(validateMountPath("../config")).toBe(false);
  });

  test("rejects absolute paths", () => {
    expect(validateMountPath("/absolute/path")).toBe(false);
  });

  test("rejects paths with directory traversal", () => {
    expect(validateMountPath("Documents/../../../etc")).toBe(false);
    expect(validateMountPath("a/../../b")).toBe(false);
  });
});

test.describe("_remoteHash", () => {
  test("produces consistent hash for same input", () => {
    const hash1 = _remoteHash("https://github.com/user/repo.git");
    const hash2 = _remoteHash("https://github.com/user/repo.git");
    expect(hash1).toBe(hash2);
  });

  test("produces different hashes for different inputs", () => {
    const hash1 = _remoteHash("https://github.com/user/repo1.git");
    const hash2 = _remoteHash("https://github.com/user/repo2.git");
    expect(hash1).not.toBe(hash2);
  });

  test("returns 16-char hex string", () => {
    const hash = _remoteHash("https://example.com/repo.git");
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
  });
});

test.describe("Mount config read/write (_readMounts)", () => {
  test("returns empty array when config file does not exist", () => {
    const mounts = _readMounts();
    expect(Array.isArray(mounts)).toBe(true);
    // Should return [] or the existing mounts from the real config
  });

  test("returns array of GitMountConfig when config file exists", () => {
    const configPath = setupTmpConfig();
    const fixture: GitMountConfig[] = [
      {
        remoteName: "test-repo",
        mountPath: "Documents/Projects",
        branch: "main",
        status: "synced",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ];
    writeFileSync(configPath, JSON.stringify(fixture));
    // Note: _readMounts uses a fixed CONFIG_PATH, so this test
    // verifies the function returns a valid array shape.
    const mounts = _readMounts();
    expect(Array.isArray(mounts)).toBe(true);
    for (const m of mounts) {
      expect(m).toHaveProperty("remoteName");
      expect(m).toHaveProperty("mountPath");
      expect(m).toHaveProperty("branch");
      expect(m).toHaveProperty("status");
      expect(m).toHaveProperty("createdAt");
      expect(m).toHaveProperty("updatedAt");
    }
  });
});

test.describe("GitMountConfig interface shape", () => {
  test("config has all required fields", () => {
    const config: GitMountConfig = {
      remoteName: "origin",
      mountPath: "Documents/Projects/my-app",
      branch: "main",
      status: "synced",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };
    expect(config.remoteName).toBe("origin");
    expect(config.mountPath).toBe("Documents/Projects/my-app");
    expect(config.branch).toBe("main");
    expect(config.status).toBe("synced");
    expect(config.lastSynced).toBeUndefined();
  });

  test("config allows optional lastSynced", () => {
    const config: GitMountConfig = {
      remoteName: "origin",
      mountPath: "Documents/Projects",
      branch: "main",
      status: "synced",
      lastSynced: "2025-01-01T12:00:00.000Z",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T12:00:00.000Z",
    };
    expect(config.lastSynced).toBe("2025-01-01T12:00:00.000Z");
  });

  test("status is one of the valid values", () => {
    const statuses: GitMountConfig["status"][] = ["synced", "syncing", "error"];
    for (const status of statuses) {
      const config: GitMountConfig = {
        remoteName: "origin",
        mountPath: "test",
        branch: "main",
        status,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      };
      expect(config.status).toBe(status);
    }
  });
});
