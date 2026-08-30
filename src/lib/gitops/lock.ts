import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { gitLogger } from "./logging";

// GitLock — serialises ALL git operations per-repo. Different repos can run in
// parallel; operations on the SAME repo are queued. The lock is backed by both
// an in-memory map and a `.git-lock` file in each repo's working directory.
//
// Deadlock prevention: if two operations on different repos both need a shared
// resource (e.g. bare cache), callers should acquire locks in alphabetical order
// of `repoPath`. The GitLock itself does NOT enforce ordering — that is the
// caller's responsibility.

export type ReleaseFn = () => Promise<void>;

interface LockRecord {
  holder: string;
  acquiredAt: number;
  timeout: NodeJS.Timeout | null;
}

interface LockFileContent {
  holder: string;
  acquiredAt: number;
  timeout: number;
}

const LOCK_TIMEOUT_MS = 30_000;
const LOCK_FILE = ".git-lock";

function normaliseRepo(repoPath: string): string {
  return path.resolve(repoPath);
}

function lockFilePath(repoPath: string): string {
  return path.join(normaliseRepo(repoPath), LOCK_FILE);
}

async function readLockFile(filePath: string): Promise<LockFileContent | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as LockFileContent;
  } catch {
    return null;
  }
}

async function writeLockFile(filePath: string, record: LockFileContent): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(record), "utf8");
}

async function removeLockFile(filePath: string): Promise<void> {
  try {
    await fs.rm(filePath, { force: true });
  } catch (err) {
    // Self-healing (the next acquire() treats a lingering lock file as stale
    // once LOCK_TIMEOUT_MS passes), so this doesn't need to throw — but it
    // must be visible, since a persistently-failing removal here is a real
    // signal something's wrong with the repo's filesystem permissions.
    gitLogger().warn({ op: "git-lock.remove-failed", repoPath: path.dirname(filePath), error: { code: "LOCK_FILE_REMOVE_FAILED", message: (err as Error).message } });
  }
}

function isStale(record: LockFileContent): boolean {
  return Date.now() - record.acquiredAt > LOCK_TIMEOUT_MS;
}

export class GitLock {
  /** In-memory queue per repo. Each queue entry holds a deferred resolve. */
  private queues = new Map<string, Array<() => void>>();
  /** Currently held locks. */
  private held = new Map<string, LockRecord>();

  /**
   * Acquire a lock for `repoPath`. Resolves with a `release` function when
   * the lock is obtained. The lock is automatically released after
   * `LOCK_TIMEOUT_MS` with a warning.
   */
  async acquire(repoPath: string, operation: string): Promise<ReleaseFn> {
    const key = normaliseRepo(repoPath);
    const lockFile = lockFilePath(repoPath);

    // Check for stale file-based lock.
    const fileLock = await readLockFile(lockFile);
    if (fileLock && isStale(fileLock)) {
      gitLogger().warn({
        op: "git-lock.stale",
        repoPath,
        durationMs: Date.now() - fileLock.acquiredAt,
      });
      await removeLockFile(lockFile);
      // Also clear any in-memory hold for this repo.
      const existing = this.held.get(key);
      if (existing) {
        if (existing.timeout) clearTimeout(existing.timeout);
        this.held.delete(key);
      }
    }

    // If someone else holds the lock, wait.
    const current = this.held.get(key);
    if (current) {
      await new Promise<void>((resolve) => {
        const q = this.queues.get(key);
        if (q) q.push(resolve);
        else this.queues.set(key, [resolve]);
      });
    }

    // Write file-based lock.
    const lockRecord: LockFileContent = {
      holder: operation,
      acquiredAt: Date.now(),
      timeout: LOCK_TIMEOUT_MS,
    };
    await writeLockFile(lockFile, lockRecord);

    // Set up auto-release timeout.
    const timeout = setTimeout(() => {
      gitLogger().warn({
        op: "git-lock.timeout",
        repoPath,
        durationMs: LOCK_TIMEOUT_MS,
      });
      this.forceRelease(key, repoPath).catch(() => {});
    }, LOCK_TIMEOUT_MS);
    // Don't keep the process alive for lock timeouts.
    timeout.unref();

    this.held.set(key, { holder: operation, acquiredAt: Date.now(), timeout });

    gitLogger().debug({ op: "git-lock.acquire", repoPath, remote: operation });

    // Return release function.
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await this.release(key, repoPath);
    };
  }

  private async release(key: string, repoPath: string): Promise<void> {
    const record = this.held.get(key);
    if (record?.timeout) clearTimeout(record.timeout);
    this.held.delete(key);

    await removeLockFile(lockFilePath(repoPath));

    gitLogger().debug({ op: "git-lock.release", repoPath });

    // Wake up next waiter.
    const q = this.queues.get(key);
    if (q && q.length > 0) {
      const next = q.shift()!;
      next();
    } else {
      this.queues.delete(key);
    }
  }

  private async forceRelease(key: string, repoPath: string): Promise<void> {
    await this.release(key, repoPath);
  }

  /**
   * Convenience wrapper: acquires a lock, runs `fn`, releases the lock,
   * and returns the result. If `fn` throws, the lock is still released.
   */
  async withLock<T>(
    repoPath: string,
    operation: string,
    fn: (release: ReleaseFn) => Promise<T>,
  ): Promise<T> {
    const release = await this.acquire(repoPath, operation);
    try {
      return await fn(release);
    } finally {
      await release();
    }
  }

  /**
   * Check if a repo is currently locked.
   */
  isLocked(repoPath: string): boolean {
    return this.held.has(normaliseRepo(repoPath));
  }
}

// Singleton.
let _instance: GitLock | undefined;

export function gitLock(): GitLock {
  return (_instance ??= new GitLock());
}
