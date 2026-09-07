import "server-only";
import { promises as fs } from "fs";
import { randomUUID } from "crypto";
import { currentVersionLabel, logger } from "@/lib/logging";
import * as vfs from "@/os/vfs";
import { hostPath } from "@/os/vfs";
import { calculateNextRun, validateScheduleConfig } from "./schedule";
import { validateUpdate, assertDeletable } from "./acl";
import {
  DAEMON_LOCK_NAME,
  acquireLock,
  beginHeartbeat,
  discardLock,
  isReclaimable,
  jobLockName,
  readLock,
  releaseLock,
  releaseLockSync,
  type LockHandle,
} from "./lock";
import type {
  CreateJobInput,
  JobDefinition,
  JobExecution,
  JobHandler,
  UpdateJobInput,
} from "./types";

// ── Unified Job Engine ────────────────────────────────────────────────────
//
// One source of truth for every scheduled unit of work in BOS: System loops,
// User agent prompts, and Integration polls. All three categories persist to
// the same VFS file so the user can inspect them side-by-side (or edit the
// file directly with an editor / the file API — the engine re-reads on
// external mutation via `reloadIfChanged()`).
//
// - Storage:  /Documents/System/scheduler-jobs.json  (atomic write)
// - History:  /Documents/System/scheduler-history/<jobId>.jsonl  (append-only)
// - Dispatch: pluggable handler registry keyed by `handler.kind`
//
// Concurrency model (042-scheduler-daemon-lock). Two layers, because BOS runs
// SEVERAL server processes over one data root (Supervisor BASE + PREVIEW, plus
// `next dev` workers) and every one of them calls startDaemon() from
// instrumentation.ts:
//
//  1. Owner election. startDaemon() no longer starts ticking; it competes for
//     the container-wide `daemon` lock (./lock.ts) and only the winner ticks.
//     Losers keep polling, so a crashed owner is taken over rather than
//     wedging the scheduler.
//  2. Per-job dispatch locks. Every dispatch first takes an atomic per-job
//     lock, held (with a heartbeat) for the duration of the run. So even if two
//     daemons somehow coexist, a due job still runs exactly once.
//
// Within one process the cheap guards still apply: a tick guard prevents
// overlap and the in-memory `runningJobIds` set short-circuits before touching
// the filesystem — but the on-disk lock, not that set, is the authority.
// External mutations to the JSON file are detected via mtime and force a
// reload before the next tick.

const LOG = "scheduler.engine";
export const JOBS_VFS_PATH = "/Documents/System/scheduler-jobs.json";
export const HISTORY_VFS_DIR = "/Documents/System/scheduler-history";

// ── Handler registry ──────────────────────────────────────────────────────

export interface HandlerRunResult {
  status: "success" | "error";
  output?: string;
  error?: string;
}

export type JobHandlerFn = (
  handler: JobHandler,
  job: JobDefinition,
) => Promise<HandlerRunResult>;

const handlerRegistry = new Map<JobHandler["kind"], JobHandlerFn>();

/**
 * Register (or replace) a handler for one `handler.kind`. Idempotent —
 * subsystems call this at boot to install their executor. Missing handlers do
 * NOT crash the engine; jobs with an unknown kind are logged and paused.
 */
export function registerHandler(kind: JobHandler["kind"], fn: JobHandlerFn): void {
  handlerRegistry.set(kind, fn);
  logger().info(LOG, `handler registered: ${kind}`);
}

// ── Store ─────────────────────────────────────────────────────────────────

interface StoreShape {
  jobs: JobDefinition[];
  // Reserved for migration bookkeeping (FR-016). Populated by migrate.ts.
  _meta?: {
    version: number;
    migratedSources?: string[];
  };
}

const EMPTY_STORE: StoreShape = { jobs: [], _meta: { version: 1 } };

// In-memory cache: last-read snapshot plus the mtime we saw for the file.
// Used by the daemon tick to skip an fs read when nothing external has
// changed. All writes go through writeStore() which refreshes both.
let cache: { store: StoreShape; mtimeMs: number } | null = null;

async function readStoreFresh(): Promise<StoreShape> {
  try {
    const raw = await vfs.readText(JOBS_VFS_PATH);
    const parsed = JSON.parse(raw) as StoreShape;
    if (!Array.isArray(parsed.jobs)) return { ...EMPTY_STORE };
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY_STORE };
    throw err;
  }
}

async function currentMtime(): Promise<number> {
  try {
    const st = await fs.stat(hostPath(JOBS_VFS_PATH));
    return st.mtimeMs;
  } catch {
    return 0;
  }
}

async function loadStore(): Promise<StoreShape> {
  const mtime = await currentMtime();
  if (cache && cache.mtimeMs === mtime) return cache.store;
  const store = await readStoreFresh();
  cache = { store, mtimeMs: mtime };
  return store;
}

async function writeStore(store: StoreShape): Promise<void> {
  await vfs.writeText(JOBS_VFS_PATH, JSON.stringify(store, null, 2));
  cache = { store, mtimeMs: await currentMtime() };
}

/**
 * Force a re-read on next access. Useful after a migration writes new jobs
 * out-of-band, or in tests.
 */
export function invalidateCache(): void {
  cache = null;
}

// ── CRUD ──────────────────────────────────────────────────────────────────

export async function listJobs(): Promise<JobDefinition[]> {
  const store = await loadStore();
  return store.jobs.slice();
}

export async function getJob(jobId: string): Promise<JobDefinition | null> {
  const store = await loadStore();
  return store.jobs.find((j) => j.id === jobId) ?? null;
}

/**
 * Create a job. If `input.id` is provided and already exists, the call is a
 * no-op and returns the existing job — this is how `ensureSystemJob` seeds
 * idempotently.
 */
export async function createJob(input: CreateJobInput): Promise<JobDefinition> {
  validateScheduleConfig(input.scheduleConfig);
  const store = await loadStore();
  if (input.id) {
    const existing = store.jobs.find((j) => j.id === input.id);
    if (existing) return existing;
  }
  const now = new Date().toISOString();
  const job: JobDefinition = {
    id: input.id ?? randomUUID(),
    name: input.name.trim() || "Untitled Job",
    category: input.category ?? "user",
    handler: input.handler,
    scheduleType: input.scheduleConfig.type,
    scheduleConfig: input.scheduleConfig,
    status: "active",
    nextRunAt: calculateNextRun(input.scheduleConfig),
    createdAt: now,
    updatedAt: now,
    ...(input.owner ? { owner: input.owner } : {}),
    ...(input.readOnlyFields ? { readOnlyFields: input.readOnlyFields } : {}),
    ...(input.deleteAfterExecution ? { deleteAfterExecution: true } : {}),
  };
  await writeStore({ ...store, jobs: [...store.jobs, job] });
  logger().info(LOG, `job created: ${job.name}`, {
    id: job.id,
    category: job.category,
    kind: job.handler.kind,
  });
  return job;
}

export async function updateJob(
  jobId: string,
  updates: UpdateJobInput,
): Promise<JobDefinition | null> {
  if (updates.scheduleConfig) validateScheduleConfig(updates.scheduleConfig);
  const store = await loadStore();
  const idx = store.jobs.findIndex((j) => j.id === jobId);
  if (idx === -1) return null;
  const prev = store.jobs[idx];
  const aclErr = validateUpdate(prev, updates);
  if (aclErr) throw new Error(aclErr);
  const next: JobDefinition = {
    ...prev,
    ...(updates.name !== undefined ? { name: updates.name } : {}),
    ...(updates.handler !== undefined ? { handler: updates.handler } : {}),
    ...(updates.deleteAfterExecution !== undefined
      ? { deleteAfterExecution: updates.deleteAfterExecution }
      : {}),
    updatedAt: new Date().toISOString(),
  };
  if (updates.scheduleConfig) {
    next.scheduleConfig = updates.scheduleConfig;
    next.scheduleType = updates.scheduleConfig.type;
    if (next.status === "active") {
      next.nextRunAt = calculateNextRun(updates.scheduleConfig, next.lastExecutedAt);
    }
  }
  const jobs = store.jobs.slice();
  jobs[idx] = next;
  await writeStore({ ...store, jobs });
  return next;
}

export async function deleteJob(jobId: string, opts: { force?: boolean } = {}): Promise<boolean> {
  const store = await loadStore();
  const job = store.jobs.find((j) => j.id === jobId);
  if (!job) return false;
  if (!opts.force) assertDeletable(job);
  const jobs = store.jobs.filter((j) => j.id !== jobId);
  await writeStore({ ...store, jobs });
  // Delete history file too. Best-effort — a stray history file is harmless.
  await vfs.remove(historyPath(jobId)).catch(() => {});
  // And its dispatch lock, so a deleted-then-recreated id never inherits one.
  await discardLock(jobLockName(jobId));
  logger().info(LOG, `job deleted: ${job.name}`, { id: job.id, category: job.category });
  return true;
}

export async function pauseJob(jobId: string): Promise<JobDefinition | null> {
  const store = await loadStore();
  const idx = store.jobs.findIndex((j) => j.id === jobId);
  if (idx === -1) return null;
  const jobs = store.jobs.slice();
  jobs[idx] = { ...jobs[idx], status: "paused", nextRunAt: null, updatedAt: new Date().toISOString() };
  await writeStore({ ...store, jobs });
  return jobs[idx];
}

export async function resumeJob(jobId: string): Promise<JobDefinition | null> {
  const store = await loadStore();
  const idx = store.jobs.findIndex((j) => j.id === jobId);
  if (idx === -1) return null;
  const prev = store.jobs[idx];
  if (prev.status === "completed") return prev;
  const jobs = store.jobs.slice();
  jobs[idx] = {
    ...prev,
    status: "active",
    nextRunAt: calculateNextRun(prev.scheduleConfig, prev.lastExecutedAt),
    updatedAt: new Date().toISOString(),
  };
  await writeStore({ ...store, jobs });
  return jobs[idx];
}

// ── System-job seeding ────────────────────────────────────────────────────

/**
 * Idempotently ensure a system-category job exists. Subsystems call this at
 * boot with a stable `id` (e.g. `memory.fast-loop`). If a job with that id
 * already exists, its schedule/handler are RESET to the caller's declaration
 * (so the subsystem always wins for the fields it owns), while status and
 * lastExecutedAt are preserved. See spec FR-004.
 */
export async function ensureSystemJob(
  spec: Omit<CreateJobInput, "category"> & { id: string; owner: string },
): Promise<JobDefinition> {
  validateScheduleConfig(spec.scheduleConfig);
  const store = await loadStore();
  const existing = store.jobs.find((j) => j.id === spec.id);
  const now = new Date().toISOString();
  if (existing) {
    const next: JobDefinition = {
      ...existing,
      name: spec.name,
      handler: spec.handler,
      // Keep any user-adjusted interval if the owner allows it; otherwise the
      // owner's declared schedule is authoritative. We take the conservative
      // default and let the owner keep the current config unless it doesn't
      // match the declared type.
      scheduleType: spec.scheduleConfig.type,
      scheduleConfig:
        existing.scheduleType === spec.scheduleConfig.type
          ? existing.scheduleConfig
          : spec.scheduleConfig,
      owner: spec.owner,
      category: "system",
      readOnlyFields: spec.readOnlyFields,
      updatedAt: now,
    };
    if (next.status === "active") {
      next.nextRunAt = calculateNextRun(next.scheduleConfig, next.lastExecutedAt);
    }
    const jobs = store.jobs.map((j) => (j.id === spec.id ? next : j));
    await writeStore({ ...store, jobs });
    return next;
  }
  return createJob({ ...spec, category: "system" });
}

// ── Execution & history ───────────────────────────────────────────────────

function historyPath(jobId: string): string {
  // The forward slash is fine — path.posix.normalize is what the VFS uses.
  return `${HISTORY_VFS_DIR}/${jobId}.jsonl`;
}

async function appendHistory(exec: JobExecution): Promise<void> {
  await vfs.mkdir(HISTORY_VFS_DIR);
  const file = hostPath(historyPath(exec.jobId));
  await fs.appendFile(file, JSON.stringify(exec) + "\n", "utf8");
}

/**
 * Read history for a job, oldest first. Reads the JSONL file line-by-line;
 * malformed lines are skipped with a warning rather than crashing the caller.
 */
export async function listHistory(jobId: string, limit = 500): Promise<JobExecution[]> {
  try {
    const raw = await vfs.readText(historyPath(jobId));
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const start = Math.max(0, lines.length - limit);
    const out: JobExecution[] = [];
    for (let i = start; i < lines.length; i++) {
      try {
        out.push(JSON.parse(lines[i]));
      } catch {
        // Tolerate one bad line (e.g. a partial write from a hard crash).
      }
    }
    return out;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Commit an execution result: append to history, advance nextRunAt for
 * recurring jobs, mark one-time jobs completed (or remove if opted-in).
 * Never throws — errors are logged and the job simply doesn't advance.
 */
async function recordExecution(
  jobId: string,
  outcome: Omit<JobExecution, "id" | "jobId">,
): Promise<JobDefinition | null> {
  const store = await loadStore();
  const idx = store.jobs.findIndex((j) => j.id === jobId);
  if (idx === -1) return null;
  const prev = store.jobs[idx];
  const execution: JobExecution = { id: randomUUID(), jobId, ...outcome };
  await appendHistory(execution);

  const now = new Date().toISOString();
  const nextRunAt =
    prev.scheduleType === "one-time"
      ? null
      : calculateNextRun(prev.scheduleConfig, execution.executedAt);

  const next: JobDefinition = {
    ...prev,
    lastExecutedAt: execution.executedAt,
    nextRunAt,
    updatedAt: now,
  };
  if (prev.scheduleType === "one-time" && outcome.status === "success") {
    next.status = "completed";
  }

  if (next.status === "completed" && prev.deleteAfterExecution) {
    const jobs = store.jobs.filter((j) => j.id !== jobId);
    await writeStore({ ...store, jobs });
    return next;
  }

  const jobs = store.jobs.slice();
  jobs[idx] = next;
  await writeStore({ ...store, jobs });
  return next;
}

// ── Runner ────────────────────────────────────────────────────────────────

async function runJob(job: JobDefinition): Promise<JobExecution> {
  const startedAt = Date.now();
  const executedAt = new Date(startedAt).toISOString();
  logger().info(LOG, `run job: ${job.name}`, {
    id: job.id,
    category: job.category,
    kind: job.handler.kind,
  });
  const handler = handlerRegistry.get(job.handler.kind);
  if (!handler) {
    const error = `No handler registered for kind "${job.handler.kind}"`;
    logger().error(LOG, error, undefined, { jobId: job.id });
    await recordExecution(job.id, {
      executedAt,
      status: "error",
      duration: Date.now() - startedAt,
      error,
    });
    // Auto-pause so we don't burn CPU re-trying a broken handler every tick.
    await pauseJob(job.id).catch(() => {});
    return { id: "", jobId: job.id, executedAt, status: "error", duration: Date.now() - startedAt, error };
  }
  try {
    const result = await handler(job.handler, job);
    const duration = Date.now() - startedAt;
    if (result.status === "success") {
      logger().info(LOG, `job ok: ${job.name}`, { jobId: job.id, duration });
    } else {
      logger().error(LOG, `job failed: ${job.name}`, result.error, { jobId: job.id });
    }
    await recordExecution(job.id, {
      executedAt,
      status: result.status,
      duration,
      ...(result.output !== undefined ? { output: result.output.slice(0, 4000) } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
    });
    return {
      id: "",
      jobId: job.id,
      executedAt,
      status: result.status,
      duration,
      ...(result.output !== undefined ? { output: result.output.slice(0, 4000) } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  } catch (err) {
    const duration = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    logger().error(LOG, `job crashed: ${job.name}`, err, { jobId: job.id });
    await recordExecution(job.id, {
      executedAt,
      status: "error",
      duration,
      error: message,
    });
    return { id: "", jobId: job.id, executedAt, status: "error", duration, error: message };
  }
}

// ── Daemon loop ───────────────────────────────────────────────────────────

const DEFAULT_TICK_MS = 60_000;

// Daemon-lock timings. The owner refreshes every HEARTBEAT_MS; a record older
// than MAX_AGE_MS (or one whose PID is gone) is reclaimable. The gap between
// them absorbs a slow tick or a long GC pause without handing the daemon over.
// Losers re-run the election every ELECTION_MS, which bounds how long
// scheduling pauses after the owner dies.
const DAEMON_LOCK_MAX_AGE_MS = 90_000;
const DAEMON_HEARTBEAT_MS = 15_000;
const DAEMON_ELECTION_MS = 30_000;

// Job locks outlive the daemon lock: an agent-prompt job can legitimately run
// for minutes, and it heartbeats throughout.
const JOB_LOCK_MAX_AGE_MS = 120_000;
const JOB_HEARTBEAT_MS = 20_000;

interface DaemonState {
  running: boolean;
  timer: NodeJS.Timeout | null;
  lastCheck: number | null;
  tickMs: number;
  ticking: boolean;
  runningJobIds: Set<string>;
  // 042: daemon ownership. `wanted` = this process asked for a daemon and has
  // not stopped it, so it keeps standing in the election even while it loses.
  wanted: boolean;
  electing: boolean;
  electionTimer: NodeJS.Timeout | null;
  daemonLock: LockHandle | null;
  stopHeartbeat: (() => void) | null;
  electionMs: number;
  lockMaxAgeMs: number;
  heartbeatMs: number;
}

// The daemon state lives on globalThis so every module instance shares ONE
// daemon: Next dev (Turbopack) compiles instrumentation.ts and route handlers
// into separate module graphs, and without this each would get its own `state`
// — the daemon would tick in the instrumentation copy while routes reported
// `running: false`. A single shared object keeps status accurate and guarantees
// exactly one ticking daemon per process (same pattern as run-command/run-manager).
const g = globalThis as unknown as { __bosSchedulerState?: DaemonState };
const state: DaemonState = (g.__bosSchedulerState ??= {
  running: false,
  timer: null,
  lastCheck: null,
  tickMs: DEFAULT_TICK_MS,
  ticking: false,
  runningJobIds: new Set(),
  wanted: false,
  electing: false,
  electionTimer: null,
  daemonLock: null,
  stopHeartbeat: null,
  electionMs: DAEMON_ELECTION_MS,
  lockMaxAgeMs: DAEMON_LOCK_MAX_AGE_MS,
  heartbeatMs: DAEMON_HEARTBEAT_MS,
});

export interface DaemonStatus {
  running: boolean;
  lastCheck: number | null;
  tickMs: number;
  /** True when THIS process holds the daemon lock and is the one ticking. */
  owner?: boolean;
  /** PID of the process that owns the daemon (this one, or another). */
  ownerPid?: number;
}

/** This process's view: is *it* the ticking daemon? Synchronous, no I/O. */
export function getDaemonStatus(): DaemonStatus {
  return {
    running: state.running,
    lastCheck: state.lastCheck,
    tickMs: state.tickMs,
    owner: state.running,
    ...(state.daemonLock ? { ownerPid: state.daemonLock.pid } : {}),
  };
}

/**
 * Container-wide view, for the UI: a process that lost the election is not
 * ticking, but the scheduler as a whole is very much running. Without this the
 * Scheduler app would report "Daemon idle" whenever its request happened to be
 * served by a non-owner process.
 */
export async function readDaemonStatus(): Promise<DaemonStatus> {
  const mine = getDaemonStatus();
  if (mine.running) return mine;
  const rec = await readLock(DAEMON_LOCK_NAME);
  // Same staleness rule the election uses, so status never claims a daemon that
  // the next election is about to reclaim.
  if (!rec || isReclaimable(rec, state.lockMaxAgeMs)) return mine;
  return {
    running: true,
    owner: false,
    ownerPid: rec.pid,
    lastCheck: rec.heartbeatAt,
    tickMs: state.tickMs,
  };
}

export async function tick(): Promise<void> {
  if (state.ticking) return;
  state.ticking = true;
  state.lastCheck = Date.now();
  try {
    const jobs = await listJobs();
    const now = Date.now();
    const due = jobs.filter(
      (j) =>
        j.status === "active" &&
        j.nextRunAt !== null &&
        Date.parse(j.nextRunAt) <= now &&
        !state.runningJobIds.has(j.id),
    );
    if (due.length === 0) return;
    await Promise.all(due.map((job) => runOne(job)));
  } catch (err) {
    logger().error(LOG, "tick failed", err);
  } finally {
    state.ticking = false;
  }
}

/**
 * Dispatch one job, exactly once container-wide.
 *
 * LAYER 2 of 042: the per-job lock is taken atomically (a single link(2) in
 * ./lock.ts) and held for the whole run, so two daemons — or a daemon plus a
 * "Run now" click on another process — cannot both dispatch the same job. The
 * in-memory set is only a free fast path for the common re-entrant case.
 */
async function runOne(job: JobDefinition): Promise<void> {
  if (state.runningJobIds.has(job.id)) return;
  const lock = await acquireLock(jobLockName(job.id), {
    maxAgeMs: JOB_LOCK_MAX_AGE_MS,
    label: `${currentVersionLabel()}:${job.name}`,
  });
  if (!lock) {
    // Another process is running this exact job right now. Not an error: the
    // job simply already fired for this due instant.
    logger().info(LOG, `job already claimed elsewhere: ${job.name}`, { id: job.id });
    return;
  }
  state.runningJobIds.add(job.id);
  // A prompt job can run for minutes; keep the lock young so nobody reclaims it
  // mid-run, and notice if somebody did anyway.
  const stopHeartbeat = beginHeartbeat(lock, JOB_HEARTBEAT_MS, () => {
    logger().error(LOG, `job lock lost while running: ${job.name}`, undefined, { id: job.id });
  });
  try {
    await runJob(job);
  } catch (err) {
    logger().error(LOG, `unhandled job error: ${job.name}`, err);
  } finally {
    stopHeartbeat();
    state.runningJobIds.delete(job.id);
    await releaseLock(lock);
  }
}

/** Run a specific job immediately, out of band. Skips if already in-flight
 *  (in this process or any other — see runOne). */
export async function runJobNow(job: JobDefinition): Promise<void> {
  await runOne(job);
}

// ── Owner election (LAYER 1 of 042) ───────────────────────────────────────
//
// Every server process calls startDaemon() at boot, but only the one holding
// the container-wide daemon lock ticks. The others stay in the election so a
// crashed owner is taken over within `electionMs`.

async function runElection(): Promise<void> {
  if (!state.wanted || state.running || state.electing) return;
  state.electing = true;
  try {
    const lock = await acquireLock(DAEMON_LOCK_NAME, {
      maxAgeMs: state.lockMaxAgeMs,
      label: currentVersionLabel(),
    });
    if (!lock) return; // someone else owns it; try again next election
    state.daemonLock = lock;
    beginTicking();
  } catch (err) {
    logger().error(LOG, "daemon election failed", err);
  } finally {
    state.electing = false;
  }
}

function beginTicking(): void {
  state.running = true;
  logger().info(LOG, "daemon starting (elected owner)", {
    tickMs: state.tickMs,
    pid: process.pid,
  });
  state.stopHeartbeat = beginHeartbeat(state.daemonLock!, state.heartbeatMs, () => {
    // We were reclaimed (e.g. this process was suspended past the max age).
    // Stand down immediately rather than tick alongside the new owner.
    logger().error(LOG, "daemon lock lost — standing down", undefined, { pid: process.pid });
    standDown();
  });
  void tick();
  state.timer = setInterval(() => void tick(), state.tickMs);
  state.timer.unref?.();
}

/** Stop ticking but stay in the election (used when the lock is taken away). */
function standDown(): void {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.stopHeartbeat?.();
  state.stopHeartbeat = null;
  state.daemonLock = null;
  state.running = false;
}

/**
 * Ask this process to run the scheduler daemon. It ticks only if it wins the
 * daemon lock; otherwise it waits and retries. Idempotent — a second call while
 * already running or already standing in the election is a no-op, exactly as
 * before 042.
 */
export function startDaemon(
  opts: { tickMs?: number; electionMs?: number; lockMaxAgeMs?: number } = {},
): void {
  if (state.running || state.electionTimer) return;
  state.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  state.electionMs = opts.electionMs ?? DAEMON_ELECTION_MS;
  state.lockMaxAgeMs = opts.lockMaxAgeMs ?? DAEMON_LOCK_MAX_AGE_MS;
  // Always refresh several times inside the staleness window, so a caller that
  // shortens lockMaxAgeMs (tests, a tighter deployment) cannot end up losing
  // its own lock between heartbeats.
  state.heartbeatMs = Math.max(500, Math.min(DAEMON_HEARTBEAT_MS, Math.floor(state.lockMaxAgeMs / 4)));
  state.wanted = true;
  void runElection();
  state.electionTimer = setInterval(() => void runElection(), state.electionMs);
  state.electionTimer.unref?.();
}

export function stopDaemon(): void {
  if (!state.wanted && !state.running) return;
  logger().info(LOG, "daemon stopping");
  state.wanted = false;
  if (state.electionTimer) clearInterval(state.electionTimer);
  state.electionTimer = null;
  const lock = state.daemonLock;
  standDown();
  // Released synchronously so the next process can take over immediately (and
  // so a test's teardown never leaks a lock into the following test).
  if (lock) releaseLockSync(lock);
}
