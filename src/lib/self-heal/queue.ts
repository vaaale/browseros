import "server-only";
import { logger } from "@/lib/logging";
import { withIndex, getCase, updateCase, readIndex } from "./store";
import { readSelfHealConfig } from "./config";
import { emitSelfHeal, casePayload, summaryFor, SELF_HEAL_LOG } from "./events";
import { SELF_HEAL_EVENTS, type QueueEntry } from "./types";

// The two bounded queues + the suspended-timeout sweep (031-self-healing
// FR-020/FR-015c, design ADR-9).
//
// They are DISTINCT concerns and must not be conflated:
//   costQueue — cases admitted while the daily cap was already spent. They have
//               not been diagnosed yet; they wait for the next UTC day.
//   slowQueue — cases already diagnosed and escalated, waiting for the single
//               `bs-pipeline` slot. Dequeuing one is RE-ENTRY, not a new
//               trigger, so it is deliberately NOT re-checked against dedupe or
//               the cost cap: the case was already accepted.
//
// Both are bounded (max size + TTL) and every eviction emits an event. A
// silently dropped case is indistinguishable from a case that was handled, so
// eviction is always announced (FR-020's "logged, never silent").

// ── Cost queue ──────────────────────────────────────────────────────────────

/** Enqueue a capped-out case. Applies the size bound (FIFO eviction of the
 *  oldest) and returns the entries evicted so the caller can announce them. */
export async function enqueueCost(caseId: string): Promise<QueueEntry[]> {
  const cfg = await readSelfHealConfig();
  const evicted = await withIndex((index) => {
    if (!index.costQueue.some((e) => e.caseId === caseId)) {
      index.costQueue.push({ caseId, at: Date.now() });
    }
    const out: QueueEntry[] = [];
    while (index.costQueue.length > cfg.costQueueMax) {
      const gone = index.costQueue.shift();
      if (gone) out.push(gone);
    }
    return out;
  });
  for (const entry of evicted) await announceEviction(entry, "queue full");
  return evicted;
}

/** Drop every cost-queue entry older than the TTL, announcing each. Called
 *  before a dequeue and by the reconcile sweep. */
export async function sweepCostQueueTtl(now: number = Date.now()): Promise<QueueEntry[]> {
  const cfg = await readSelfHealConfig();
  const ttlMs = cfg.costQueueTtlDays * 86_400_000;
  const evicted = await withIndex((index) => {
    const keep: QueueEntry[] = [];
    const out: QueueEntry[] = [];
    for (const entry of index.costQueue) {
      if (now - entry.at > ttlMs) out.push(entry);
      else keep.push(entry);
    }
    index.costQueue = keep;
    return out;
  });
  for (const entry of evicted) await announceEviction(entry, `older than ${cfg.costQueueTtlDays}d`);
  return evicted;
}

async function announceEviction(entry: QueueEntry, reason: string): Promise<void> {
  const record = await getCase(entry.caseId);
  await updateCase(entry.caseId, {
    status: "abandoned",
    error: `evicted from the cost-cap queue (${reason})`,
    note: `evicted from the cost-cap queue (${reason})`,
  });
  await emitSelfHeal(SELF_HEAL_EVENTS.costCapEvicted, {
    caseId: entry.caseId,
    reason,
    queuedAt: entry.at,
    ...(record ? { trigger: record.trigger, title: record.title, dedupeKey: record.signature.dedupeKey } : {}),
    summary: record ? summaryFor(record, `evicted from the cost queue (${reason})`) : `Self-heal case ${entry.caseId} evicted (${reason})`,
    selfHeal: { role: "lifecycle", caseId: entry.caseId },
  });
  logger().warn(SELF_HEAL_LOG, "cost-queue eviction", { caseId: entry.caseId, reason });
}

/** Pop the oldest cost-queued case id, after evicting anything stale. */
export async function dequeueCost(now: number = Date.now()): Promise<string | undefined> {
  await sweepCostQueueTtl(now);
  return withIndex((index) => index.costQueue.shift()?.caseId);
}

export async function costQueueLength(): Promise<number> {
  return (await readIndex()).costQueue.length;
}

// ── Slow-path queue (the single-slot FIFO) ──────────────────────────────────

/** Queue an escalated case behind the in-flight one (FR-015c). Idempotent. */
export async function enqueueSlow(caseId: string): Promise<number> {
  return withIndex((index) => {
    if (!index.slowQueue.some((e) => e.caseId === caseId)) {
      index.slowQueue.push({ caseId, at: Date.now() });
    }
    return index.slowQueue.findIndex((e) => e.caseId === caseId) + 1;
  });
}

/** Pop the next escalated case. Unlike the cost queue this has no TTL: an
 *  escalated case is a real, accepted piece of work and is never silently
 *  dropped for waiting. */
export async function dequeueSlow(): Promise<string | undefined> {
  return withIndex((index) => index.slowQueue.shift()?.caseId);
}

export async function slowQueueIds(): Promise<string[]> {
  return (await readIndex()).slowQueue.map((e) => e.caseId);
}

// ── Suspended-timeout sweep (FR-016 scenario 3, ADR-9) ──────────────────────

/**
 * Any case parked in `suspended` past `suspendedTimeoutDays` becomes
 * `abandoned`: the case closes, `self_heal.abandoned` is emitted, and the
 * slow-path slot is released (updateCase does that in the same transaction).
 *
 * Returns the ids it abandoned, so the caller can log a single line.
 */
export async function sweepSuspendedTimeouts(now: number = Date.now()): Promise<string[]> {
  const cfg = await readSelfHealConfig();
  const timeoutMs = cfg.suspendedTimeoutDays * 86_400_000;
  const index = await readIndex();
  const candidates = Object.entries(index.cases)
    .filter(([, v]) => v.status === "suspended")
    .map(([id]) => id);

  const abandoned: string[] = [];
  for (const id of candidates) {
    const record = await getCase(id);
    if (!record || record.status !== "suspended") continue;
    const since = record.suspendedAt ?? record.updatedAt;
    if (now - since <= timeoutMs) continue;
    const updated = await updateCase(id, {
      status: "abandoned",
      error: `no answer within ${cfg.suspendedTimeoutDays} day(s)`,
      note: `suspended-timeout expired after ${cfg.suspendedTimeoutDays} day(s) — case abandoned`,
    });
    if (!updated) continue;
    abandoned.push(id);
    await emitSelfHeal(SELF_HEAL_EVENTS.abandoned, {
      ...casePayload(updated),
      reason: `suspended for more than ${cfg.suspendedTimeoutDays} day(s) with no answer`,
      summary: summaryFor(updated, "abandoned (no answer)"),
    });
  }
  if (abandoned.length) {
    logger().warn(SELF_HEAL_LOG, "abandoned suspended cases", { caseIds: abandoned.join(",") });
  }
  return abandoned;
}
