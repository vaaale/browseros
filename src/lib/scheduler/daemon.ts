import "server-only";
import { logger } from "@/lib/logging";
import { listTasks } from "./storage";
import { executeTask } from "./executor";
import type { Task } from "./types";

const LOG = "scheduler.daemon";
const DEFAULT_TICK_MS = 60_000;

// Module-level singleton state: the daemon runs once per Node process.
interface DaemonState {
  running: boolean;
  timer: NodeJS.Timeout | null;
  lastCheck: number | null;
  tickMs: number;
  // Guard against overlap when a tick still executing at the next interval.
  ticking: boolean;
  // Prevent double-execution of the same task within a single tick.
  runningTaskIds: Set<string>;
}

const state: DaemonState = {
  running: false,
  timer: null,
  lastCheck: null,
  tickMs: DEFAULT_TICK_MS,
  ticking: false,
  runningTaskIds: new Set(),
};

export interface DaemonStatus {
  running: boolean;
  lastCheck: number | null;
  tickMs: number;
}

export function getDaemonStatus(): DaemonStatus {
  return { running: state.running, lastCheck: state.lastCheck, tickMs: state.tickMs };
}

/**
 * Kick a single scheduler tick immediately. Safe to call while the daemon
 * loop is idle or already running — it de-duplicates in-flight tasks and
 * simply runs any tasks whose nextRunAt has passed.
 */
export async function tick(): Promise<void> {
  if (state.ticking) return;
  state.ticking = true;
  state.lastCheck = Date.now();
  try {
    const tasks = await listTasks();
    const now = Date.now();
    const due = tasks.filter(
      (t) =>
        t.status === "active" &&
        t.nextRunAt !== null &&
        Date.parse(t.nextRunAt) <= now &&
        !state.runningTaskIds.has(t.id),
    );
    if (due.length === 0) return;
    // Run due tasks in parallel; each swallows its own errors so one bad task
    // never affects the rest of the tick.
    await Promise.all(due.map((task) => runOne(task)));
  } catch (err) {
    logger().error(LOG, "tick failed", err);
  } finally {
    state.ticking = false;
  }
}

async function runOne(task: Task): Promise<void> {
  state.runningTaskIds.add(task.id);
  try {
    await executeTask(task);
  } catch (err) {
    // executeTask should never throw, but belt-and-suspenders: the daemon must
    // survive any single-task failure.
    logger().error(LOG, `unhandled task error: ${task.name}`, err);
  } finally {
    state.runningTaskIds.delete(task.id);
  }
}

/**
 * Trigger a specific task to run right now, out of band. Returns immediately if
 * the task is already running to avoid double-execution.
 */
export async function runTaskNow(task: Task): Promise<void> {
  if (state.runningTaskIds.has(task.id)) return;
  await runOne(task);
}

export function startDaemon(opts: { tickMs?: number } = {}): void {
  if (state.running) return;
  state.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  state.running = true;
  logger().info(LOG, "daemon starting", { tickMs: state.tickMs });
  // Kick off an immediate tick so past-due tasks execute on boot without
  // waiting a full interval.
  void tick();
  state.timer = setInterval(() => void tick(), state.tickMs);
  // Do not keep the Node event loop alive on its own — the Next.js server
  // owns that. Without unref, a lingering interval would prevent shutdown.
  state.timer.unref?.();
}

export function stopDaemon(): void {
  if (!state.running) return;
  logger().info(LOG, "daemon stopping");
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.running = false;
}
