import "server-only";
import { collectRunnableJobs, listJobStatus, runJobOnce } from "./jobs";
import type { SchedulerStatus } from "./types";

// In-process polling daemon.
//
// Lifecycle:
//   - `ensureSchedulerStarted()` is idempotent and lazy — the first request to
//     `/api/integrations` (or a UI action / poll route) triggers it, so we
//     don't tick during static build.
//   - Interval is unref'd so it never keeps the Node process alive on its own
//     (Next dev / prod would exit anyway on SIGINT; test runners can too).
//   - TICK_INTERVAL_MS is deliberately larger than MIN_INTERVAL_SEC (which
//     bounds per-job intervals): the daemon checks eligibility on every tick,
//     so a coarse tick keeps CPU low and jobs still fire within a few seconds
//     of their scheduled time.
//
// Failure isolation: one job's exception must not stop the daemon. `runJobOnce`
// swallows all errors already, but we also wrap each iteration in a try/catch
// so an unexpected throw in the eligibility check itself can't kill the loop.

const TICK_INTERVAL_MS = 15_000;

interface DaemonState {
  timer: NodeJS.Timeout;
  startedAt: number;
  lastTickAt?: number;
  tickCount: number;
}

// Lives on globalThis (same pattern as scheduler/engine.ts) so a dev hot-reload
// gets the SAME daemon instead of orphaning the old interval — an orphaned timer
// keeps ticking forever and pins its entire stale module graph in memory.
const g = globalThis as unknown as { __bosIntegrationsDaemon?: DaemonState };

/** True once the daemon interval is active. */
export function isSchedulerRunning(): boolean {
  return g.__bosIntegrationsDaemon !== undefined;
}

/**
 * Ensure the polling daemon is running. Idempotent — safe to call from every
 * `/api/integrations*` route handler. First call starts the interval; further
 * calls return immediately.
 */
export function ensureSchedulerStarted(): void {
  if (g.__bosIntegrationsDaemon) return;
  const timer = setInterval(() => {
    void tick();
  }, TICK_INTERVAL_MS);
  timer.unref?.();
  g.__bosIntegrationsDaemon = { timer, startedAt: Date.now(), tickCount: 0 };
  // Fire once shortly after start so we don't wait a full interval for the
  // first tick — helpful right after enabling polling in the UI.
  setTimeout(() => {
    void tick();
  }, 500).unref?.();
}

/** Stop the daemon. Test/hot-reload only — production callers never stop it. */
export function stopScheduler(): void {
  const daemon = g.__bosIntegrationsDaemon;
  if (!daemon) return;
  clearInterval(daemon.timer);
  g.__bosIntegrationsDaemon = undefined;
}

/**
 * Manually run a single tick. Used by the /api/integrations/scheduler POST
 * endpoint (developer-only) and by tests. Never throws.
 */
export async function tick(): Promise<void> {
  const state = g.__bosIntegrationsDaemon;
  if (!state) return;
  state.lastTickAt = Date.now();
  state.tickCount += 1;
  let jobs: Awaited<ReturnType<typeof collectRunnableJobs>>;
  try {
    jobs = await collectRunnableJobs(state.lastTickAt);
  } catch {
    return;
  }
  // Run jobs sequentially — each poll may hit the same OAuth refresh; there's
  // no upside to parallelising a handful of adapters. Kept as `for...of` so a
  // later change can `Promise.allSettled(...)` without a big refactor.
  for (const job of jobs) {
    try {
      await runJobOnce(job.integrationId, job.serviceId);
    } catch {
      // runJobOnce is documented not to throw, but belt + suspenders.
    }
  }
}

/** Snapshot the daemon's current status. Called by /api/integrations/scheduler GET. */
export function getSchedulerStatus(): SchedulerStatus {
  const daemon = g.__bosIntegrationsDaemon;
  if (!daemon) {
    return { running: false, tickCount: 0, jobs: listJobStatus() };
  }
  return {
    running: true,
    lastTickAt: daemon.lastTickAt,
    tickCount: daemon.tickCount,
    jobs: listJobStatus(),
  };
}
