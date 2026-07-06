import "server-only";
import { promises as fs } from "fs";
import { writeFileAtomic } from "@/os/atomic-write";
import { ensureTelegramDir, queueFile } from "./paths";

// Offline send queue for the Telegram bot.
//
// Any message dispatched via the adapter's send methods when the network is
// unavailable (or Telegram returns a persistent server error) is enqueued
// here and retried with exponential backoff. A single background flush loop
// (started lazily by the poller/scheduler) drains the queue.
//
// Persistence: JSON file at `data/integrations/telegram/queue.json`. Each
// entry carries the full method + args so a process restart resumes work
// where it left off. Attempts + nextAttemptAt drive backoff.
//
// Concurrency: an in-process mutex serialises read-modify-write. We reload
// on every mutation so an external edit (e.g. UI clear) is picked up.

const MAX_ATTEMPTS = 8; // ~ 2^8 * base ≈ 25 min at 6s base — enough for typical outages.
const BASE_BACKOFF_SEC = 6;
const MAX_BACKOFF_SEC = 30 * 60;

export interface QueuedSend {
  /** Monotonic id; also serialised as the array position for stable ordering. */
  id: string;
  /** Bot API method name (e.g. "sendMessage", "sendPhoto"). */
  method: string;
  /**
   * Request payload. For text methods this is the JSON body; for multipart
   * methods (`sendPhoto`, `sendDocument`) it's the JSON metadata + a `filePath`
   * pointing at a BOS VFS or absolute path — the worker rehydrates it into a
   * FormData at flush time.
   */
  payload: Record<string, unknown>;
  /** Epoch-ms when this entry was queued. */
  queuedAt: number;
  /** Consecutive failed attempts. */
  attempts: number;
  /** Epoch-ms of the next eligible retry. */
  nextAttemptAt: number;
  /** Last error message, for the UI. */
  lastError?: string;
}

interface OnDisk {
  version: 1;
  entries: QueuedSend[];
}

function emptyOnDisk(): OnDisk {
  return { version: 1, entries: [] };
}

class Mutex {
  private busy = false;
  private waiters: Array<() => void> = [];
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) await new Promise<void>((res) => this.waiters.push(res));
    this.busy = true;
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.busy = false;
    }
  }
}

const mutex = new Mutex();

async function readAll(): Promise<OnDisk> {
  try {
    const raw = await fs.readFile(queueFile(), "utf8");
    const parsed = JSON.parse(raw) as OnDisk;
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) return emptyOnDisk();
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyOnDisk();
    throw err;
  }
}

async function writeAll(disk: OnDisk): Promise<void> {
  await ensureTelegramDir();
  await writeFileAtomic(queueFile(), JSON.stringify(disk, null, 2));
}

function nextBackoffSec(attempts: number): number {
  const doubled = BASE_BACKOFF_SEC * 2 ** Math.min(attempts, 10);
  return Math.min(MAX_BACKOFF_SEC, doubled);
}

/** List queued items (newest first). Snapshot — safe to render in UI. */
export async function listQueue(): Promise<QueuedSend[]> {
  const disk = await readAll();
  return [...disk.entries];
}

/**
 * Enqueue a send. Called by the adapter when a live send fails with a
 * transient error (network down, 5xx after retries). The worker picks it up
 * on the next flush.
 */
export async function enqueue(input: {
  method: string;
  payload: Record<string, unknown>;
  error?: string;
}): Promise<QueuedSend> {
  return mutex.run(async () => {
    const disk = await readAll();
    const entry: QueuedSend = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      method: input.method,
      payload: input.payload,
      queuedAt: Date.now(),
      attempts: 0,
      nextAttemptAt: Date.now(),
      lastError: input.error,
    };
    disk.entries.unshift(entry);
    await writeAll(disk);
    return entry;
  });
}

/**
 * Remove an entry by id. Used by the worker on success and by the UI's
 * "cancel" button.
 */
export async function remove(id: string): Promise<boolean> {
  return mutex.run(async () => {
    const disk = await readAll();
    const before = disk.entries.length;
    disk.entries = disk.entries.filter((e) => e.id !== id);
    if (disk.entries.length === before) return false;
    await writeAll(disk);
    return true;
  });
}

/**
 * Record a failed attempt: bump attempts, push nextAttemptAt out by an
 * exponentially-increasing wait, and stash the error. When attempts hits
 * MAX_ATTEMPTS the caller (worker) removes the entry — no `dead-letter`
 * store yet; the last error stays in state.services.bot.error for the UI.
 */
export async function recordFailure(id: string, error: string): Promise<QueuedSend | null> {
  return mutex.run(async () => {
    const disk = await readAll();
    const idx = disk.entries.findIndex((e) => e.id === id);
    if (idx < 0) return null;
    const existing = disk.entries[idx];
    const attempts = existing.attempts + 1;
    const backoff = nextBackoffSec(attempts);
    const updated: QueuedSend = {
      ...existing,
      attempts,
      nextAttemptAt: Date.now() + backoff * 1000,
      lastError: error,
    };
    disk.entries[idx] = updated;
    await writeAll(disk);
    return updated;
  });
}

/** Clear the entire queue. UI "clear queue" button. */
export async function clearAll(): Promise<number> {
  return mutex.run(async () => {
    const disk = await readAll();
    const n = disk.entries.length;
    disk.entries = [];
    await writeAll(disk);
    return n;
  });
}

/**
 * Return every entry whose retry window has elapsed. The worker calls this on
 * each flush tick.
 */
export async function collectDue(now = Date.now()): Promise<QueuedSend[]> {
  const disk = await readAll();
  return disk.entries.filter((e) => e.nextAttemptAt <= now);
}

/** Max attempts before an entry is dropped. Exported for the worker/UI. */
export const QUEUE_MAX_ATTEMPTS = MAX_ATTEMPTS;
