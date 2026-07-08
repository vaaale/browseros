import "server-only";
import { getAdapterEntry, listAdapterServices } from "../actions/adapter-registry";
import { emitNotification } from "../notifications/store";
import { mutateState, readState } from "../state/store";
import type { GmailAdapter } from "../services/gsuite/adapters/gmail";
import {
  IntegrationAuthError,
  IntegrationConfigError,
  IntegrationError,
  IntegrationScopeError,
} from "../errors";
import type { PollConfig, SchedulerJobStatus } from "./types";
import {
  MAX_BACKOFF_SEC,
  MAX_INTERVAL_SEC,
  MIN_INTERVAL_SEC,
} from "./types";

// Scheduler job execution. Each (integrationId, serviceId) pair is one job.
// The daemon (see daemon.ts) iterates every enabled + connected service on
// each tick, checks the poll config + backoff, and calls `runJobOnce` here.
//
// Exponential backoff (per Phase 2 spec):
//   - Base wait on failure  = current intervalSec (min 30s)
//   - Each subsequent consecutive failure doubles it, capped at 30 min.
//   - A single successful poll resets failures/backoff.
//
// Jobs are keyed by "<integrationId>/<serviceId>"; recent status is tracked in
// an in-memory map for the /api/integrations/scheduler UI (no persistence — a
// restart is fine; the persisted PollConfig carries the last error + retryAfter).

interface Pollable {
  pollOnce: (params: { since?: number; maxResults?: number }) => ReturnType<GmailAdapter["pollOnce"]>;
}

const runtimeStatus = new Map<string, SchedulerJobStatus>();

function jobKey(integrationId: string, serviceId: string): string {
  return `${integrationId}/${serviceId}`;
}

/** Clamp user-configured intervals to the [MIN, MAX] window. */
export function clampInterval(sec: number): number {
  if (!Number.isFinite(sec) || sec <= 0) return MIN_INTERVAL_SEC;
  return Math.max(MIN_INTERVAL_SEC, Math.min(MAX_INTERVAL_SEC, Math.floor(sec)));
}

/**
 * Compute the next backoff wait (seconds) given the current PollConfig. Doubles
 * the previous backoff or starts at intervalSec.
 */
function nextBackoffSec(config: PollConfig): number {
  const interval = clampInterval(config.intervalSec);
  const prev = config.backoffSec && config.backoffSec > 0 ? config.backoffSec : interval;
  const doubled = prev * 2;
  return Math.min(MAX_BACKOFF_SEC, doubled);
}

/** Returns the runtime status of every observed job. Snapshot only. */
export function listJobStatus(): SchedulerJobStatus[] {
  return Array.from(runtimeStatus.values()).map((s) => ({ ...s }));
}

/** Read the runtime status for a single job (fresh copy). */
export function getJobStatus(integrationId: string, serviceId: string): SchedulerJobStatus | undefined {
  const s = runtimeStatus.get(jobKey(integrationId, serviceId));
  return s ? { ...s } : undefined;
}

function updateRuntimeStatus(
  integrationId: string,
  serviceId: string,
  patch: Partial<SchedulerJobStatus>,
): void {
  const key = jobKey(integrationId, serviceId);
  const existing = runtimeStatus.get(key) ?? {
    integrationId,
    serviceId,
    enabled: false,
    intervalSec: MIN_INTERVAL_SEC,
    failures: 0,
  };
  runtimeStatus.set(key, { ...existing, ...patch });
}

/**
 * Return the list of (integrationId, serviceId) pairs whose PollConfig is
 * enabled and whose backoff window has elapsed. Called by the daemon on each
 * tick. Non-connected integrations are skipped silently — the OAuth manager
 * would fail anyway.
 */
export async function collectRunnableJobs(now = Date.now()): Promise<Array<{ integrationId: string; serviceId: string; config: PollConfig }>> {
  const out: Array<{ integrationId: string; serviceId: string; config: PollConfig }> = [];
  // We iterate the adapter registry rather than every integration in state:
  // only services with an adapter can be polled. Cheap — a handful of entries.
  const services = listAdapterServices();
  for (const svc of services) {
    const state = await readState(svc.integrationId);
    if (!state.connected) continue;
    const svcState = state.services[svc.serviceId];
    if (!svcState?.enabled) continue;
    const config = (svcState.config?.poll as PollConfig | undefined) ?? undefined;
    if (!config?.enabled) continue;
    if (config.retryAfter && config.retryAfter > now) {
      updateRuntimeStatus(svc.integrationId, svc.serviceId, {
        enabled: true,
        intervalSec: clampInterval(config.intervalSec),
        nextEligibleAt: config.retryAfter,
        failures: config.failures ?? 0,
        lastError: config.lastError,
      });
      continue;
    }
    // Respect the configured interval when we already have a lastAttempt.
    const last = runtimeStatus.get(jobKey(svc.integrationId, svc.serviceId))?.lastAttemptAt;
    const interval = clampInterval(config.intervalSec);
    if (last && now - last < interval * 1000) continue;
    out.push({ integrationId: svc.integrationId, serviceId: svc.serviceId, config });
  }
  return out;
}

/**
 * Execute exactly one poll for one (integrationId, serviceId) pair. Emits
 * every returned event to the notifications store, updates persistent state
 * (lastSync + poll.lastError/retryAfter) and runtime status, and applies
 * backoff on failure. Never throws — errors are captured in state.
 */
export async function runJobOnce(integrationId: string, serviceId: string): Promise<{
  ok: boolean;
  newMessages?: number;
  error?: string;
}> {
  const entry = getAdapterEntry(integrationId, serviceId);
  if (!entry) return { ok: false, error: `no adapter for ${integrationId}/${serviceId}` };
  const adapter = entry.createAdapter();
  const pollable = adapter as unknown as Partial<Pollable>;
  if (typeof pollable.pollOnce !== "function") {
    return { ok: false, error: `${integrationId}/${serviceId} does not support polling` };
  }

  const started = Date.now();
  updateRuntimeStatus(integrationId, serviceId, { lastAttemptAt: started, enabled: true });

  try {
    // Feed `since` from lastSync when present — cheaper polls, less duplicate work.
    const state = await readState(integrationId);
    const svcState = state.services[serviceId];
    const since = svcState?.lastSync;
    const result = await pollable.pollOnce({ since });
    let emitted = 0;
    for (const ev of result.events) {
      await emitNotification(ev);
      emitted++;
    }
    await mutateState(integrationId, (prev) => {
      const services = { ...prev.services };
      const existing = services[serviceId] ?? { enabled: true, config: {} };
      const existingConfig = existing.config ?? {};
      const existingPoll = (existingConfig.poll as PollConfig | undefined) ?? {
        enabled: true,
        intervalSec: MIN_INTERVAL_SEC,
      };
      services[serviceId] = {
        ...existing,
        lastSync: started,
        error: undefined,
        config: {
          ...existingConfig,
          poll: {
            ...existingPoll,
            lastError: undefined,
            retryAfter: undefined,
            backoffSec: 0,
            failures: 0,
          },
        },
      };
      return { ...prev, services };
    });
    updateRuntimeStatus(integrationId, serviceId, {
      lastSuccessAt: started,
      failures: 0,
      lastError: undefined,
      nextEligibleAt: undefined,
    });
    return { ok: true, newMessages: emitted };
  } catch (err) {
    const message = describeError(err);
    // Persist failure + advance backoff. We stash the computed nextBackoff on
    // the outer variable so the runtime-status update below can use the same
    // value instead of re-deriving it (which would require another state read).
    let nextBackoff = 0;
    let failures = 0;
    await mutateState(integrationId, (prev) => {
      const services = { ...prev.services };
      const existing = services[serviceId] ?? { enabled: true, config: {} };
      const existingConfig = existing.config ?? {};
      const existingPoll = (existingConfig.poll as PollConfig | undefined) ?? {
        enabled: true,
        intervalSec: MIN_INTERVAL_SEC,
      };
      nextBackoff = nextBackoffSec(existingPoll);
      failures = (existingPoll.failures ?? 0) + 1;
      services[serviceId] = {
        ...existing,
        error: message,
        config: {
          ...existingConfig,
          poll: {
            ...existingPoll,
            lastError: message,
            retryAfter: started + nextBackoff * 1000,
            backoffSec: nextBackoff,
            failures,
          },
        },
      };
      return { ...prev, services };
    }).catch(() => {});
    updateRuntimeStatus(integrationId, serviceId, {
      lastError: message,
      failures,
      nextEligibleAt: started + nextBackoff * 1000,
    });
    return { ok: false, error: message };
  }
}

function describeError(err: unknown): string {
  if (err instanceof IntegrationScopeError) return `Scope disabled: ${err.scope}`;
  if (err instanceof IntegrationAuthError) return `Auth failed: ${err.message}`;
  if (err instanceof IntegrationConfigError) return `Config invalid: ${err.message}`;
  if (err instanceof IntegrationError) return err.message;
  if (err instanceof Error) return err.message;
  return "poll failed";
}

/** Test-only: forget every job's runtime status. */
export function _resetSchedulerRuntime(): void {
  runtimeStatus.clear();
}
