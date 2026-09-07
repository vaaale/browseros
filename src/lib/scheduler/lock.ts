import "server-only";
import { promises as fs, existsSync, readFileSync, unlinkSync } from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { dataDir } from "@/os/data-dir";

// ── Cross-process file locks for the job engine ───────────────────────────
//
// Why this exists (042-scheduler-daemon-lock): every Node server process runs
// `register()` in src/instrumentation.ts, and therefore used to start its own
// scheduler daemon. The Supervisor keeps at least two such processes alive (a
// BASE plus, while a feature branch is previewed, a PREVIEW), and `next dev`
// adds more. All of them ticked the same due job in the same ~60s window, so a
// non-idempotent job (the "Daily Review") launched N concurrent runs. The
// engine's only guards — a module-level `runningJobIds` Set and a per-process
// `globalThis` daemon singleton — are invisible across process boundaries.
//
// The fix needs a lock that is (a) shared by every process in the container and
// (b) genuinely atomic. Both properties come from the filesystem:
//
//   ATOMICITY. A lock is ONLY ever granted by `fs.link(staged, lockFile)`.
//   link(2) fails with EEXIST if the target exists, and does so atomically —
//   there is no read-then-write gap for a second process to slip through. (We
//   link a pre-written staging file rather than open(…, "wx") + write so the
//   lock file is never observable in a half-written, "no owner yet" state.)
//
//   SHARING. Lock files live under `lockRoot()` — see below.
//
// Liveness. A holder that crashes must not wedge scheduling forever, so every
// record carries `pid` + `heartbeatAt` and holders refresh the heartbeat while
// they work. A record is reclaimable when its heartbeat has aged out, or (same
// host only) when its PID is provably gone.

/** The on-disk lock file contents. Small, human-readable, and safe to `cat`. */
export interface LockRecord {
  /** Lock name, duplicated into the body so a stray file identifies itself. */
  name: string;
  pid: number;
  /** `os.hostname()`. PID liveness only means something on the same host. */
  host: string;
  /** Unique per acquisition — the authority for "is this lock still mine?". */
  token: string;
  acquiredAt: number;
  heartbeatAt: number;
  /** Which BOS version/process took it (BOS_VERSION_LABEL), for debugging. */
  label?: string;
}

/** Proof of ownership. Pass it back to refresh/release. */
export interface LockHandle {
  name: string;
  file: string;
  token: string;
  pid: number;
}

export interface AcquireOptions {
  /** A record whose heartbeat is at least this old is reclaimable. */
  maxAgeMs?: number;
  label?: string;
}

/** Default staleness window. Holders heartbeat far more often than this. */
export const DEFAULT_LOCK_MAX_AGE_MS = 60_000;

/**
 * Where lock files live: `<container data root>/scheduler/`.
 *
 * BOS_CANONICAL_DATA, not BOS_DATA_DIR, when both are set. The two racing
 * processes in production are the Supervisor's BASE and PREVIEW, and those have
 * DIFFERENT BOS_DATA_DIRs (a preview runs on a throwaway hardlink clone of the
 * data dir — tools/supervisor/lib/proc.mjs) while sharing one
 * BOS_CANONICAL_DATA. A BOS_DATA_DIR-rooted lock would therefore not dedup the
 * exact case this feature exists to fix: both versions carry a copy of the same
 * job id and would each fire it. Canonical rooting is also what os/vfs.ts does
 * for state that must survive a preview clone being discarded, and it sidesteps
 * hardlink-clone aliasing (a clone hardlinks existing files, so a lock created
 * before the clone would appear pre-held inside it).
 *
 * Outside the Supervisor, BOS_CANONICAL_DATA is unset and this is just
 * `dataDir()/scheduler` — i.e. per user container, exactly as intended.
 * Resolved per call, never cached: tests override the env after import.
 */
export function lockRoot(): string {
  const canonical = process.env.BOS_CANONICAL_DATA?.trim();
  return path.join(canonical || dataDir(), "scheduler");
}

/** The lock file backing `name` (slashes in the name become nested dirs). */
export function lockPath(name: string): string {
  const safe = name
    .split("/")
    .map((seg) => seg.replace(/[^A-Za-z0-9._-]/g, "_"))
    .filter((seg) => seg.length > 0 && seg !== "." && seg !== "..")
    .join(path.sep);
  if (!safe) throw new Error(`Invalid lock name: ${name}`);
  return path.join(lockRoot(), `${safe}.lock`);
}

/** The daemon-ownership lock: whoever holds it runs THE scheduler daemon. */
export const DAEMON_LOCK_NAME = "daemon";

/** Per-job dispatch lock, so one due job runs once container-wide. */
export function jobLockName(jobId: string): string {
  return `job-locks/${jobId}`;
}

/**
 * Is `pid` still running?
 *
 * `process.kill(pid, 0)` sends no signal, it only performs the permission +
 * existence check:
 *   - ESRCH  → no such process → dead.
 *   - EPERM  → the process exists but belongs to another user → ALIVE. Treating
 *              this as dead would let one container's user steal a lock that is
 *              genuinely held.
 * Anything else (including Windows, where the call is emulated) is treated as
 * alive: refusing to reclaim is always the safe direction — the heartbeat check
 * still expires a truly dead holder.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function parseRecord(raw: string): LockRecord | null {
  try {
    const rec = JSON.parse(raw) as LockRecord;
    if (typeof rec?.token !== "string" || typeof rec?.pid !== "number") return null;
    if (typeof rec.heartbeatAt !== "number") return null;
    return rec;
  } catch {
    return null;
  }
}

/** The current holder of `name`, or null if the lock is free/unreadable. */
export async function readLock(name: string): Promise<LockRecord | null> {
  try {
    return parseRecord(await fs.readFile(lockPath(name), "utf8"));
  } catch {
    return null;
  }
}

/**
 * May we take a lock away from the process described by `rec`?
 *
 * A malformed/truncated record (`null`) counts as reclaimable — that is a
 * half-written leftover from a hard kill, not a live holder.
 */
export function isReclaimable(rec: LockRecord | null, maxAgeMs: number, now = Date.now()): boolean {
  if (!rec) return true;
  if (now - rec.heartbeatAt >= maxAgeMs) return true;
  // A dead PID is reclaimed immediately (no need to wait out the heartbeat),
  // but only when the record was written on THIS host: PIDs from another
  // machine/container sharing the directory are meaningless numbers here.
  if (rec.host === os.hostname() && !isPidAlive(rec.pid)) return true;
  return false;
}

/** Read a record together with the inode that held it (see `stealStale`). */
async function readHeld(file: string): Promise<{ rec: LockRecord | null; ino: bigint } | null> {
  let handle;
  try {
    handle = await fs.open(file, "r");
  } catch {
    return null;
  }
  try {
    const [st, raw] = await Promise.all([handle.stat({ bigint: true }), handle.readFile("utf8")]);
    return { rec: parseRecord(raw), ino: st.ino };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Remove a stale lock file so the caller can re-compete for it.
 *
 * `rename` — not `unlink` — because rename of the SOURCE is itself atomic: when
 * several processes spot the same stale record, exactly one rename succeeds and
 * the rest get ENOENT. That matters because the loser must NOT go on to delete
 * whatever file has replaced it. The inode check before the rename adds the
 * second half of that guarantee: we only ever displace the exact file we read
 * and judged stale, never a fresh lock that was linked in the meantime (a new
 * holder always links a NEW file, so a changed inode means "someone beat us").
 */
async function stealStale(file: string, ino: bigint): Promise<void> {
  try {
    const st = await fs.stat(file, { bigint: true });
    if (st.ino !== ino) return; // replaced under us — re-read on the next pass
  } catch {
    return; // already gone
  }
  const stolen = `${file}.stale.${process.pid}.${randomUUID()}`;
  try {
    await fs.rename(file, stolen);
  } catch {
    return; // another process reclaimed it first
  }
  await fs.rm(stolen, { force: true }).catch(() => {});
}

/**
 * Try to take `name`. Returns a handle on success, null if someone else holds
 * it. Never throws for ordinary contention.
 *
 * The whole acquisition is one atomic `link()`; the surrounding loop only exists
 * to retry after reclaiming a stale record (and to re-check who won that race).
 */
export async function acquireLock(
  name: string,
  opts: AcquireOptions = {},
): Promise<LockHandle | null> {
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_LOCK_MAX_AGE_MS;
  const file = lockPath(name);
  await fs.mkdir(path.dirname(file), { recursive: true });

  // Three passes is enough for any real contention: pass 1 competes, pass 2
  // competes again after one reclaim, pass 3 settles who won that reclaim.
  for (let attempt = 0; attempt < 3; attempt++) {
    const now = Date.now();
    const record: LockRecord = {
      name,
      pid: process.pid,
      host: os.hostname(),
      token: randomUUID(),
      acquiredAt: now,
      heartbeatAt: now,
      ...(opts.label ? { label: opts.label } : {}),
    };
    const staged = `${file}.staged.${process.pid}.${record.token}`;
    await fs.writeFile(staged, JSON.stringify(record, null, 2) + "\n", "utf8");
    try {
      await fs.link(staged, file); // ← the atomic step. EEXIST = someone holds it.
      return { name, file, token: record.token, pid: record.pid };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    } finally {
      await fs.rm(staged, { force: true }).catch(() => {});
    }

    const held = await readHeld(file);
    if (!held) continue; // vanished between link and read — compete again
    if (!isReclaimable(held.rec, maxAgeMs)) return null; // legitimately held
    await stealStale(file, held.ino);
  }
  return null;
}

/**
 * Refresh our heartbeat. Returns false if the lock is no longer ours — the
 * caller MUST then stop acting as the owner (stand the daemon down / stop
 * treating a job as claimed). This is how a holder discovers it was reclaimed
 * (e.g. it was paused past `maxAgeMs` and another process took over).
 *
 * Written in place, keeping the inode, so a concurrent reclaimer's inode check
 * still refers to the same lock generation.
 */
export async function refreshLock(handle: LockHandle): Promise<boolean> {
  const rec = await readLock(handle.name);
  if (!rec || rec.token !== handle.token) return false;
  try {
    await fs.writeFile(
      handle.file,
      JSON.stringify({ ...rec, heartbeatAt: Date.now() }, null, 2) + "\n",
      "utf8",
    );
    return true;
  } catch {
    return false;
  }
}

/** Release a lock we hold. A lock that is no longer ours is left alone. */
export async function releaseLock(handle: LockHandle): Promise<void> {
  const rec = await readLock(handle.name);
  if (!rec || rec.token !== handle.token) return;
  await fs.rm(handle.file, { force: true }).catch(() => {});
}

/** Synchronous release, for `stopDaemon()` and process-exit paths. */
export function releaseLockSync(handle: LockHandle): void {
  try {
    if (!existsSync(handle.file)) return;
    const rec = parseRecord(readFileSync(handle.file, "utf8"));
    if (!rec || rec.token !== handle.token) return;
    unlinkSync(handle.file);
  } catch {
    // Best effort: a leftover file ages out via the heartbeat check anyway.
  }
}

/**
 * Keep `handle` alive on a timer for as long as the holder is working. Returns
 * a stop function. `onLost` fires (once) if a refresh shows the lock was taken.
 */
export function beginHeartbeat(
  handle: LockHandle,
  intervalMs: number,
  onLost?: () => void,
): () => void {
  let stopped = false;
  const timer = setInterval(() => {
    void refreshLock(handle).then((ok) => {
      if (ok || stopped) return;
      stopped = true;
      clearInterval(timer);
      onLost?.();
    });
  }, intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** Delete a job's lock file outright (used when the job itself is deleted). */
export async function discardLock(name: string): Promise<void> {
  await fs.rm(lockPath(name), { force: true }).catch(() => {});
}
