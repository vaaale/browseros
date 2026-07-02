// Pure schedule-math helpers. No I/O, no Node imports — safe to unit test and
// import from either side of the client/server line.

import type { RecurringSchedule, ScheduleConfig } from "./types";

const UNIT_MS: Record<RecurringSchedule["unit"], number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
};

export function validateScheduleConfig(cfg: ScheduleConfig): void {
  if (cfg.type === "one-time") {
    if (!cfg.datetime) throw new Error("One-time schedule requires a datetime");
    const t = Date.parse(cfg.datetime);
    if (!Number.isFinite(t)) throw new Error(`Invalid datetime: ${cfg.datetime}`);
    return;
  }
  if (cfg.type === "recurring") {
    if (!Number.isFinite(cfg.interval) || cfg.interval < 1) {
      throw new Error("Recurring schedule requires interval >= 1");
    }
    if (!UNIT_MS[cfg.unit]) throw new Error(`Invalid unit: ${cfg.unit}`);
    if (cfg.startTime !== undefined && !Number.isFinite(Date.parse(cfg.startTime))) {
      throw new Error(`Invalid startTime: ${cfg.startTime}`);
    }
    return;
  }
  throw new Error(`Unknown schedule type: ${(cfg as { type: string }).type}`);
}

/**
 * Compute the next run instant for a schedule.
 *
 * - One-time: returns the fixed datetime (or null if already executed).
 * - Recurring: if not yet run, returns startTime (or now) advanced past `now`
 *   to catch up missed intervals; if it has run before, returns lastExecutedAt +
 *   one interval, advanced past `now` if the daemon was asleep.
 *
 * Returns an ISO string, or null if the schedule has no more runs.
 */
export function calculateNextRun(
  cfg: ScheduleConfig,
  lastExecutedAt?: string,
  now: Date = new Date(),
): string | null {
  if (cfg.type === "one-time") {
    if (lastExecutedAt) return null;
    return new Date(cfg.datetime).toISOString();
  }
  const stepMs = UNIT_MS[cfg.unit] * cfg.interval;
  const nowMs = now.getTime();
  if (!lastExecutedAt) {
    const anchor = cfg.startTime ? Date.parse(cfg.startTime) : nowMs;
    if (anchor > nowMs) return new Date(anchor).toISOString();
    const missed = Math.ceil((nowMs - anchor) / stepMs);
    return new Date(anchor + Math.max(missed, 0) * stepMs).toISOString();
  }
  const base = Date.parse(lastExecutedAt) + stepMs;
  if (base > nowMs) return new Date(base).toISOString();
  const missed = Math.ceil((nowMs - base) / stepMs);
  return new Date(base + missed * stepMs).toISOString();
}

/** Human-readable summary of a schedule for the UI. */
export function describeSchedule(cfg: ScheduleConfig): string {
  if (cfg.type === "one-time") {
    const d = new Date(cfg.datetime);
    return Number.isNaN(d.getTime()) ? "One-time" : d.toLocaleString();
  }
  const noun = cfg.interval === 1 ? cfg.unit : `${cfg.unit}s`;
  return `Every ${cfg.interval} ${noun}`;
}
