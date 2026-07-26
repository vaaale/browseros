// Git performance benchmarks
//   npx playwright test -c playwright.unit.config.ts tests/benchmarks/git-perf.test.ts
//
// Benchmarks for git operations: lock acquisition, auth resolution,
// config CRUD, mount operations, and serialization overhead.
//
// NOTE: These benchmark the pure computational logic. Server-only modules
// (gitops/) cannot be imported directly in the Playwright test runner, so
// the relevant functions are re-implemented here following the established
// test pattern (see tests/gitops/git-remotes-tools.test.ts).

import { test, expect } from "@playwright/test";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

// ── Re-implemented pure functions (mirrors src/lib/gitops/) ──────────────────

// From remote-config.ts
interface GitRemoteConfig {
  name: string;
  url: string;
  provider: "github" | "gitlab" | "generic";
  autoPush: boolean;
  defaultBranch?: string;
  remoteBranch?: string;
  lastFetched?: string;
  lastPushed?: string;
  oauthTokenExpiresAt?: number;
  createdAt: string;
  updatedAt: string;
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

// From mount-manager.ts
function validateMountPath(mountPath: string): boolean {
  const vfsRoot = resolve(process.cwd(), "data", "vfs");
  const resolved = resolve(vfsRoot, mountPath);
  return resolved === vfsRoot || resolved.startsWith(vfsRoot + "/");
}

function remoteHash(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

// From logging.ts
const SENSITIVE_KEYS = new Set([
  "token", "tokens", "access_token", "refresh_token", "accessToken",
  "refreshToken", "pat", "password", "passphrase", "secret",
  "sshKey", "sshKeyData", "sshKeyPath", "privateKey", "private_key",
  "credentials", "authorization",
]);
const URL_CREDENTIAL_RE = /(https?:\/\/)[^:]+:[^@]+@/gi;

function sanitizeUrl(url: string): string {
  return url.replace(URL_CREDENTIAL_RE, "$1****@");
}

function redactSensitiveStrings(obj: unknown): unknown {
  if (typeof obj === "string") return sanitizeUrl(obj);
  if (Array.isArray(obj)) return obj.map(redactSensitiveStrings);
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SENSITIVE_KEYS.has(k)) out[k] = "[REDACTED]";
      else if (typeof v === "string") out[k] = sanitizeUrl(v);
      else if (typeof v === "object" && v !== null) out[k] = redactSensitiveStrings(v);
      else out[k] = v;
    }
    return out;
  }
  return obj;
}

// From git-ops.ts
function applyTokenToUrl(url: string, token: string): string {
  return url.replace(/^(https?:\/\/)/, `$1oauth2:${token}@`);
}

function parseAheadBehind(output: string): { ahead: number; behind: number } {
  const parts = output.split("\t");
  return {
    ahead: parseInt(parts[0] ?? "0", 10) || 0,
    behind: parseInt(parts[1] ?? "0", 10) || 0,
  };
}

function isAuthFailure(stderr: string): boolean {
  return (
    /authentication/i.test(stderr) ||
    /Permission denied/i.test(stderr) ||
    /fatal: .*(?:token|credential)/i.test(stderr) ||
    /401/.test(stderr) ||
    /403/.test(stderr)
  );
}

function isMergeConflict(stderr: string): boolean {
  return /CONFLICT/i.test(stderr) || /merge failed/i.test(stderr);
}

function getBareCachePath(url: string): string {
  const sanitized = url.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 128);
  const hash = createHash("md5").update(url).digest("hex").slice(0, 16);
  return `data/.git-cache/${sanitized}.${hash}.git`;
}

// From auth.ts
function isTokenExpiringSoon(tokenExpiry: number): boolean {
  const twentyFourHoursMs = 24 * 60 * 60 * 1000;
  return tokenExpiry - Date.now() < twentyFourHoursMs;
}

// ── In-memory simulation of config operations ────────────────────────────────

class SimRemoteConfig {
  private configs: GitRemoteConfig[] = [];

  readAll(): GitRemoteConfig[] {
    return [...this.configs];
  }

  add(config: Omit<GitRemoteConfig, "createdAt" | "updatedAt">): GitRemoteConfig {
    const uniqueName = getUniqueRemoteName(config.name, this.configs.map((c) => c.name));
    const now = new Date().toISOString();
    const entry: GitRemoteConfig = {
      ...config,
      name: uniqueName,
      createdAt: now,
      updatedAt: now,
    };
    this.configs.push(entry);
    return entry;
  }

  update(name: string, patch: Partial<GitRemoteConfig>): GitRemoteConfig | null {
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

  clear(): void {
    this.configs = [];
  }
}

interface SimMountConfig {
  remoteName: string;
  mountPath: string;
  branch: string;
  status: "synced" | "syncing" | "error";
  lastSynced?: string;
  createdAt: string;
  updatedAt: string;
}

class SimMountManager {
  private mounts: SimMountConfig[] = [];

  list(): SimMountConfig[] {
    return [...this.mounts];
  }

  mount(remoteName: string, mountPath: string, branch = "main"): SimMountConfig {
    if (!validateMountPath(mountPath)) {
      throw new Error(`Mount path "${mountPath}" is outside data/vfs/`);
    }
    if (this.mounts.find((m) => m.remoteName === remoteName)) {
      throw new Error(`Remote "${remoteName}" is already mounted`);
    }
    const now = new Date().toISOString();
    const config: SimMountConfig = {
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

  unmount(remoteName: string): boolean {
    const idx = this.mounts.findIndex((m) => m.remoteName === remoteName);
    if (idx === -1) return false;
    this.mounts.splice(idx, 1);
    return true;
  }

  getStatus(remoteName: string): SimMountConfig | null {
    return this.mounts.find((m) => m.remoteName === remoteName) ?? null;
  }

  updateStatus(remoteName: string, status: "syncing" | "error" | "synced"): void {
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

// ── In-memory lock simulation ────────────────────────────────────────────────

class SimLock {
  private held = new Map<string, boolean>();
  private queues = new Map<string, Array<() => void>>();

  async acquire(repoPath: string): Promise<() => Promise<void>> {
    const key = repoPath;
    if (this.held.get(key)) {
      await new Promise<void>((resolve) => {
        const q = this.queues.get(key) ?? [];
        q.push(resolve);
        this.queues.set(key, q);
      });
    }
    this.held.set(key, true);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      this.held.delete(key);
      const q = this.queues.get(key);
      if (q && q.length > 0) {
        q.shift()!();
      } else {
        this.queues.delete(key);
      }
    };
  }

  async withLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(repoPath);
    try {
      return await fn();
    } finally {
      await release();
    }
  }
}

// ── Bench helpers ────────────────────────────────────────────────────────────

function benchSync(
  label: string,
  fn: () => void,
  iterations: number,
): { avgMs: number; p50Ms: number; p99Ms: number; totalMs: number } {
  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const totalMs = times.reduce((s, t) => s + t, 0);
  return {
    avgMs: totalMs / iterations,
    p50Ms: times[Math.floor(iterations * 0.5)],
    p99Ms: times[Math.floor(iterations * 0.99)],
    totalMs,
  };
}

async function benchAsync(
  label: string,
  fn: () => Promise<void>,
  iterations: number,
): Promise<{ avgMs: number; p50Ms: number; p99Ms: number; totalMs: number }> {
  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const totalMs = times.reduce((s, t) => s + t, 0);
  return {
    avgMs: totalMs / iterations,
    p50Ms: times[Math.floor(iterations * 0.5)],
    p99Ms: times[Math.floor(iterations * 0.99)],
    totalMs,
  };
}

function logResult(label: string, stats: { avgMs: number; p50Ms: number; p99Ms: number }, unit = "ms"): void {
  console.log(`\n  ${label}:`);
  console.log(`    avg: ${stats.avgMs.toFixed(3)}${unit}`);
  console.log(`    p50: ${stats.p50Ms.toFixed(3)}${unit}`);
  console.log(`    p99: ${stats.p99Ms.toFixed(3)}${unit}`);
}

// ── Benchmarks ───────────────────────────────────────────────────────────────

const N = 1000;

test.describe("Git performance benchmarks", () => {
  // ── 1. Lock benchmarks ───────────────────────────────────────────────────

  test("lock: acquire and release (single repo, no contention)", async () => {
    const lock = new SimLock();

    const stats = await benchAsync(
      "lock.acquire+release",
      async () => {
        const release = await lock.acquire("/tmp/bench-lock-repo");
        await release();
      },
      N,
    );

    logResult("Lock acquire+release (no contention)", stats);
    expect(stats.avgMs).toBeLessThan(5);
  });

  test("lock: withLock convenience", async () => {
    const lock = new SimLock();

    const stats = await benchAsync(
      "lock.withLock",
      async () => {
        await lock.withLock("/tmp/bench-lock-repo-2", async () => {});
      },
      N,
    );

    logResult("Lock withLock", stats);
    expect(stats.avgMs).toBeLessThan(5);
  });

  test("lock: serialization overhead (concurrent vs sequential)", async () => {
    const lock = new SimLock();

    // Sequential baseline
    const sequential = await benchAsync(
      "lock.sequential",
      async () => {
        await lock.withLock("/tmp/bench-serial", async () => {});
      },
      200,
    );

    // Contended: 10 concurrent acquires on same repo
    const CONCURRENCY = 10;
    const ITERS = 100;
    const t0 = performance.now();
    for (let i = 0; i < ITERS; i++) {
      const promises: Promise<void>[] = [];
      for (let c = 0; c < CONCURRENCY; c++) {
        promises.push(
          lock.withLock("/tmp/bench-contended", async () => {
            // Simulate 0.5ms work
            await new Promise((r) => setTimeout(r, 0.5));
          }),
        );
      }
      await Promise.all(promises);
    }
    const contendedMs = performance.now() - t0;
    const perOp = contendedMs / (ITERS * CONCURRENCY);

    console.log(`\n  Lock serialization overhead:`);
    console.log(`    sequential avg: ${sequential.avgMs.toFixed(3)}ms/op`);
    console.log(`    contended avg:  ${perOp.toFixed(3)}ms/op (${CONCURRENCY} concurrent)`);
    console.log(`    overhead ratio: ${(perOp / sequential.avgMs).toFixed(1)}x`);

    expect(perOp).toBeLessThan(15);
  });

  // ── 2. Auth benchmarks (pure functions) ──────────────────────────────────

  test("auth: isTokenExpiringSoon", () => {
    const stats = benchSync(
      "auth.isTokenExpiringSoon",
      () => {
        isTokenExpiringSoon(Date.now() + 12 * 60 * 60 * 1000);
        isTokenExpiringSoon(Date.now() + 48 * 60 * 60 * 1000);
      },
      N * 10,
    );

    logResult("isTokenExpiringSoon (2 calls)", stats, "ms");
    expect(stats.avgMs).toBeLessThan(0.01);
  });

  test("auth: applyTokenToUrl", () => {
    const urls = [
      "https://github.com/user/repo.git",
      "https://gitlab.com/group/project.git",
      "https://bitbucket.org/team/repo.git",
    ];
    const tokens = ["ghp_abc123", "glpat-xyz789", "pat_def456"];

    const stats = benchSync(
      "auth.applyTokenToUrl",
      () => {
        for (const url of urls) {
          for (const token of tokens) {
            applyTokenToUrl(url, token);
          }
        }
      },
      N * 10,
    );

    logResult("applyTokenToUrl (9 calls)", stats, "ms");
    expect(stats.avgMs).toBeLessThan(0.05);
  });

  // ── 3. Remote config benchmarks ──────────────────────────────────────────

  test("remote-config: add/update/remove cycle (in-memory)", () => {
    const store = new SimRemoteConfig();

    const stats = benchSync(
      "config CRUD cycle",
      () => {
        const cfg = store.add({
          name: `bench-${performance.now()}`,
          url: "https://github.com/user/repo.git",
          provider: "github",
          autoPush: false,
        });
        store.update(cfg.name, { autoPush: true });
        store.remove(cfg.name);
      },
      N,
    );

    logResult("Config CRUD (add+update+remove)", stats);
    expect(stats.avgMs).toBeLessThan(0.1);
  });

  test("remote-config: read with 50 entries", () => {
    const store = new SimRemoteConfig();
    for (let i = 0; i < 50; i++) {
      store.add({
        name: `entry-${i}`,
        url: `https://github.com/user/repo-${i}.git`,
        provider: "github",
        autoPush: false,
      });
    }

    const stats = benchSync(
      "config.read (50 entries)",
      () => {
        store.readAll();
      },
      N,
    );

    logResult("readRemoteConfigs (50 entries)", stats);
    expect(stats.avgMs).toBeLessThan(0.05);
  });

  test("remote-config: getUniqueRemoteName with collisions", () => {
    const existing = Array.from({ length: 50 }, (_, i) => `name-${i}`);
    existing.push("target"); // The name we'll look up

    const stats = benchSync(
      "config.getUniqueRemoteName",
      () => {
        getUniqueRemoteName("target", existing);
      },
      N,
    );

    logResult("getUniqueRemoteName (50 existing)", stats);
    expect(stats.avgMs).toBeLessThan(0.1);
  });

  test("remote-config: add+remove with 200 existing entries", () => {
    const store = new SimRemoteConfig();
    for (let i = 0; i < 200; i++) {
      store.add({
        name: `large-${i}`,
        url: `https://github.com/user/repo-${i}.git`,
        provider: "github",
        autoPush: false,
      });
    }

    const stats = benchSync(
      "config add+remove (200 existing)",
      () => {
        const cfg = store.add({
          name: `temp-${performance.now()}`,
          url: "https://github.com/user/temp.git",
          provider: "github",
          autoPush: false,
        });
        store.remove(cfg.name);
      },
      N,
    );

    logResult("Config add+remove (200 existing)", stats);
    expect(stats.avgMs).toBeLessThan(0.2);
  });

  // ── 4. Mount operations benchmarks ───────────────────────────────────────

  test("mount: mount/unmount/list cycle (in-memory)", () => {
    const mgr = new SimMountManager();

    const stats = benchSync(
      "mount CRUD cycle",
      () => {
        mgr.mount(`remote-${performance.now()}`, "Bench/test", "main");
        mgr.list();
        // Unmount all
        for (const m of mgr.list()) {
          mgr.unmount(m.remoteName);
        }
      },
      N,
    );

    logResult("Mount CRUD cycle", stats);
    expect(stats.avgMs).toBeLessThan(0.2);
  });

  test("mount: listMounts with 30 entries", () => {
    const mgr = new SimMountManager();
    for (let i = 0; i < 30; i++) {
      mgr.mount(`mount-${i}`, `Docs/repo-${i}`, "main");
    }

    const stats = benchSync(
      "mount.list (30 entries)",
      () => {
        mgr.list();
      },
      N,
    );

    logResult("listMounts (30 entries)", stats);
    expect(stats.avgMs).toBeLessThan(0.05);
  });

  test("mount: validateMountPath", () => {
    const valid = ["Documents/repo", "Apps/my-app", "a/b/c", "."];
    const invalid = ["../escape", "/absolute/path", "../../etc/passwd", "a/../../../escape"];

    const stats = benchSync(
      "mount.validateMountPath",
      () => {
        for (const p of valid) validateMountPath(p);
        for (const p of invalid) validateMountPath(p);
      },
      N * 10,
    );

    logResult("validateMountPath (8 paths)", stats, "ms");
    expect(stats.avgMs).toBeLessThan(0.05);
  });

  test("mount: remoteHash", () => {
    const urls = [
      "https://github.com/user/repo.git",
      "git@gitlab.com:group/project.git",
      "generic-repo-name",
    ];

    const stats = benchSync(
      "mount.remoteHash",
      () => {
        for (const url of urls) remoteHash(url);
      },
      N * 10,
    );

    logResult("remoteHash (3 calls)", stats, "ms");
    expect(stats.avgMs).toBeLessThan(0.02);
  });

  test("mount: getMountStatus lookup in 20 entries", () => {
    const mgr = new SimMountManager();
    for (let i = 0; i < 20; i++) {
      mgr.mount(`lookup-${i}`, `Docs/repo-${i}`, "main");
    }

    const stats = benchSync(
      "mount.getStatus (20 entries)",
      () => {
        mgr.getStatus("lookup-10");
      },
      N,
    );

    logResult("getMountStatus (20 entries)", stats);
    expect(stats.avgMs).toBeLessThan(0.05);
  });

  // ── 5. Logging benchmarks (pure functions) ───────────────────────────────

  test("logging: sanitizeUrl", () => {
    const urls = [
      "https://user:pass@github.com/user/repo.git",
      "https://oauth2:ghp_abc123@github.com/user/repo.git",
      "https://github.com/user/repo.git",
      "https://x:yyyyyyyyyyyyyyyyyyyyyy@gitlab.com/group/project.git",
    ];

    const stats = benchSync(
      "logging.sanitizeUrl",
      () => {
        for (const url of urls) sanitizeUrl(url);
      },
      N * 10,
    );

    logResult("sanitizeUrl (4 URLs)", stats, "ms");
    expect(stats.avgMs).toBeLessThan(0.02);
  });

  test("logging: redactSensitiveStrings", () => {
    const entries = [
      { op: "test", token: "ghp_secret123", url: "https://user:pass@host.com/repo.git" },
      { op: "test", accessToken: "secret", nested: { pat: "secret", name: "visible" } },
      { op: "test", sshKeyData: "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----" },
    ];

    const stats = benchSync(
      "logging.redactSensitiveStrings",
      () => {
        for (const e of entries) redactSensitiveStrings(e);
      },
      N * 10,
    );

    logResult("redactSensitiveStrings (3 entries)", stats, "ms");
    expect(stats.avgMs).toBeLessThan(0.05);
  });

  // ── 6. Git-ops pure functions ────────────────────────────────────────────

  test("git-ops: getBareCachePath", () => {
    const urls = [
      "https://github.com/user/repo.git",
      "git@gitlab.com:group/project.git",
      "https://bitbucket.org/team/repo.git",
    ];

    const stats = benchSync(
      "git-ops.getBareCachePath",
      () => {
        for (const url of urls) getBareCachePath(url);
      },
      N * 10,
    );

    logResult("getBareCachePath (3 calls)", stats, "ms");
    expect(stats.avgMs).toBeLessThan(0.05);
  });

  test("git-ops: parseAheadBehind", () => {
    const outputs = ["0\t0", "5\t3", "127\t42", "1\t0", "0\t1"];

    const stats = benchSync(
      "git-ops.parseAheadBehind",
      () => {
        for (const o of outputs) parseAheadBehind(o);
      },
      N * 10,
    );

    logResult("parseAheadBehind (5 calls)", stats, "ms");
    expect(stats.avgMs).toBeLessThan(0.01);
  });

  test("git-ops: isAuthFailure pattern matching", () => {
    const stderrs = [
      "fatal: Authentication failed",
      "Permission denied (publickey)",
      "remote: 401 Unauthorized",
      "fatal: could not read Username",
      "Everything up-to-date", // not auth failure
    ];

    const stats = benchSync(
      "git-ops.isAuthFailure",
      () => {
        for (const s of stderrs) isAuthFailure(s);
      },
      N * 10,
    );

    logResult("isAuthFailure (5 patterns)", stats, "ms");
    expect(stats.avgMs).toBeLessThan(0.05);
  });

  test("git-ops: isMergeConflict pattern matching", () => {
    const stderrs = [
      "CONFLICT (content): Merge conflict in file.ts",
      "Automatic merge failed; fix conflicts and then commit",
      "fatal: Not something we can merge", // not conflict
      "merge failed", // match
      "Changes to be committed", // not conflict
    ];

    const stats = benchSync(
      "git-ops.isMergeConflict",
      () => {
        for (const s of stderrs) isMergeConflict(s);
      },
      N * 10,
    );

    logResult("isMergeConflict (5 patterns)", stats, "ms");
    expect(stats.avgMs).toBeLessThan(0.01);
  });

  // ── 7. Comparison: with vs without locks ─────────────────────────────────

  test("comparison: config CRUD with and without lock serialization", async () => {
    const lock = new SimLock();

    const withoutLock = benchSync(
      "config CRUD (no lock)",
      () => {
        const store = new SimRemoteConfig();
        const cfg = store.add({
          name: `no-lock-${performance.now()}`,
          url: "https://github.com/user/repo.git",
          provider: "github",
          autoPush: false,
        });
        store.update(cfg.name, { autoPush: true });
        store.remove(cfg.name);
      },
      500,
    );

    const withLockStats = await benchAsync(
      "config CRUD (with lock)",
      async () => {
        const store = new SimRemoteConfig();
        await lock.withLock("/tmp/bench-comparison", async () => {
          const cfg = store.add({
            name: `with-lock-${performance.now()}`,
            url: "https://github.com/user/repo.git",
            provider: "github",
            autoPush: false,
          });
          store.update(cfg.name, { autoPush: true });
          store.remove(cfg.name);
        });
      },
      500,
    );

    const overhead = withLockStats.avgMs / withoutLock.avgMs;

    console.log(`\n  Lock serialization overhead:`);
    console.log(`    without lock avg: ${withoutLock.avgMs.toFixed(3)}ms`);
    console.log(`    with lock avg:    ${withLockStats.avgMs.toFixed(3)}ms`);
    console.log(`    overhead ratio:   ${overhead.toFixed(2)}x`);

    // Lock adds negligible overhead for non-contended operations
    expect(overhead).toBeLessThan(5);
  });

  // ── 8. Full pipeline throughput ──────────────────────────────────────────

  test("throughput: simulated full add→mount→list→unmount→remove pipeline", () => {
    const remoteStore = new SimRemoteConfig();
    const mountMgr = new SimMountManager();
    const ITERS = 200;

    const start = performance.now();
    for (let i = 0; i < ITERS; i++) {
      const name = `pipeline-${i}`;

      remoteStore.add({
        name,
        url: `https://github.com/user/repo-${i}.git`,
        provider: "github",
        autoPush: false,
      });

      mountMgr.mount(name, `Pipelines/repo-${i}`, "main");

      const mounts = mountMgr.list();
      expect(mounts.length).toBeGreaterThan(0);

      const status = mountMgr.getStatus(name);
      expect(status).not.toBeNull();

      mountMgr.updateStatus(name, "synced");

      mountMgr.unmount(name);

      remoteStore.remove(name);
    }
    const totalMs = performance.now() - start;
    const perPipelineMs = totalMs / ITERS;

    console.log(`\n  Full pipeline throughput (${ITERS} iterations):`);
    console.log(`    total: ${totalMs.toFixed(1)}ms`);
    console.log(`    per pipeline: ${perPipelineMs.toFixed(3)}ms`);

    expect(perPipelineMs).toBeLessThan(2);
  });
});
