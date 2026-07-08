// Framework-free scheduler types. Safe to import from client or server.

/**
 * Per-service poll configuration persisted inside `state.services[svcId].poll`.
 * Written by the settings UI (PATCH /api/integrations/[id]), read by the
 * scheduler daemon on every tick.
 */
export interface PollConfig {
  /** Whether polling is enabled for this service. Default: false. */
  enabled: boolean;
  /** Requested interval in seconds. Clamped to [MIN_INTERVAL_SEC, MAX_INTERVAL_SEC]. */
  intervalSec: number;
  /** Last-known error surfaced by the daemon. Cleared on successful poll. */
  lastError?: string;
  /**
   * If set, the daemon is in backoff — next attempt not before this epoch-ms.
   * Cleared on successful poll.
   */
  retryAfter?: number;
  /**
   * Current backoff wait in seconds (doubles on each failure up to MAX_BACKOFF_SEC).
   * Absent or 0 when not in backoff.
   */
  backoffSec?: number;
  /** Consecutive-failure count. Reset to 0 on success. */
  failures?: number;
  /**
   * Optional advanced overrides. Left `Record<string, unknown>` so services can
   * carry their own knobs (e.g. Gmail-specific query) without another schema
   * revision.
   */
  extras?: Record<string, unknown>;
}

/** Scheduler daemon status snapshot for the UI. */
export interface SchedulerStatus {
  running: boolean;
  /** Last tick timestamp (epoch-ms), if any. */
  lastTickAt?: number;
  /** Number of ticks the daemon has performed since starting. */
  tickCount: number;
  jobs: SchedulerJobStatus[];
}

export interface SchedulerJobStatus {
  integrationId: string;
  serviceId: string;
  enabled: boolean;
  intervalSec: number;
  /** Epoch-ms of the last poll attempt (success or failure). */
  lastAttemptAt?: number;
  /** Epoch-ms of the last successful poll. */
  lastSuccessAt?: number;
  /** Epoch-ms after which the next poll may run. */
  nextEligibleAt?: number;
  failures: number;
  lastError?: string;
}

/** Bounds for user-configured intervals (30s .. 30min). */
export const MIN_INTERVAL_SEC = 30;
export const MAX_INTERVAL_SEC = 30 * 60;

/** Backoff base = the service's configured intervalSec; cap at 30 minutes. */
export const MAX_BACKOFF_SEC = 30 * 60;
