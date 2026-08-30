import "server-only";
import * as store from "./store";
import { publish } from "./stream";
import { typeMatches, RETRY_BACKOFF_MS, MAX_HANDLER_ATTEMPTS } from "./types";
import type { EventRecord, HandlerRegistration } from "./types";

// Dispatch engine (design.md §3.3/§3.5, ADR-3): fan-out to active headless
// handlers, one FIFO queue per handler (concurrency 1 → free ordering,
// concurrent ACROSS handlers per NFR-007), retry with backoff, at-least-once
// re-dispatch on boot + late registration. The riskiest module in the
// feature (plan.md Complexity Tracking) — isolated here and fully unit tested.

type OwnerRunningCheck = (ownerId: string) => boolean;
/** `callId` is the exactly-once-settle guard threaded through the worker-IPC
 *  `event_dispatch` message (core/service/types.ts) — the invoker (wired by
 *  ServiceManager, T029) forwards it so the eventual loopback ack can be
 *  matched against the specific attempt currently outstanding, not just the
 *  (event, handler) pair. */
export type HandlerInvoker = (
  ownerId: string,
  handlerId: string,
  record: EventRecord,
  timeoutMs: number,
  callId: string,
) => Promise<void>;
type CoreExecutor = (record: EventRecord) => Promise<{ result?: unknown } | void>;

interface HandlerQueue {
  pending: string[];
  busy: boolean;
}
interface Waiter {
  callId: string;
  resolve: (v: { ok: true } | { ok: false; error: string }) => void;
}

interface DispatchState {
  ownerRunningCheck: OwnerRunningCheck;
  serviceInvoker: HandlerInvoker | null;
  coreExecutors: Map<string, CoreExecutor>;
  backoffMs: readonly number[];
  queues: Map<string, HandlerQueue>;
  pendingByPair: Map<string, Waiter>;
}

// globalThis singleton — hot-reload-safe, same pattern as serviceManager()/
// the event store (Next dev/Turbopack can compile call sites into separate
// module graphs; without this, ServiceManager's wiring and the dispatch loop
// itself would silently operate on two different sets of queues/waiters).
const g = globalThis as unknown as { __bosEventDispatch?: DispatchState };

function state(): DispatchState {
  if (!g.__bosEventDispatch) {
    g.__bosEventDispatch = {
      ownerRunningCheck: () => false,
      serviceInvoker: null,
      coreExecutors: new Map(),
      backoffMs: RETRY_BACKOFF_MS,
      queues: new Map(),
      pendingByPair: new Map(),
    };
  }
  return g.__bosEventDispatch;
}

// ── Owner liveness + invocation transport (wired by ServiceManager/kernel) ──

/** Injected so this module never imports ServiceManager directly (avoids a
 *  cycle; ServiceManager doesn't otherwise need to know about events). */
export function setOwnerRunningCheck(fn: OwnerRunningCheck): void {
  state().ownerRunningCheck = fn;
}

/** Confirms the `event_dispatch` IPC message was sent to the worker — it does
 *  NOT wait for the ack; settlement arrives later via the public ack API
 *  (R1: services ack over loopback HTTP, exactly one ack path). */
export function setServiceInvoker(fn: HandlerInvoker | null): void {
  state().serviceInvoker = fn;
}

/** Core-internal headless handlers (ADR-3) — called as plain functions, no IPC. */
export function registerCoreExecutor(handlerId: string, fn: CoreExecutor): void {
  state().coreExecutors.set(handlerId, fn);
}
export function unregisterCoreExecutor(handlerId: string): void {
  state().coreExecutors.delete(handlerId);
}

/** Test seam — the real 1s/5s/30s schedule makes retry tests impractically
 *  slow; tests substitute e.g. [5, 5, 5]. */
export function _setBackoffScheduleForTests(ms: number[] | null): void {
  state().backoffMs = ms ?? RETRY_BACKOFF_MS;
}

// ── Active-set rule (data-model §4) ─────────────────────────────────────────

export function isHandlerActive(h: HandlerRegistration): boolean {
  if (h.mode !== "headless") return false;
  if (!h.enabled) return false;
  if (h.declaredBy === "core") return true;
  return state().ownerRunningCheck(h.ownerId);
}

export function activeHandlersForType(eventType: string): HandlerRegistration[] {
  return store.listHandlersForType(eventType).filter(isHandlerActive);
}

// ── Per-handler FIFO queues (concurrency 1 per handler, concurrent across) ──

function getQueue(handlerId: string): HandlerQueue {
  const s = state();
  let q = s.queues.get(handlerId);
  if (!q) {
    q = { pending: [], busy: false };
    s.queues.set(handlerId, q);
  }
  return q;
}

function enqueue(handlerId: string, eventId: string): void {
  const q = getQueue(handlerId);
  if (q.pending.includes(eventId)) return;
  q.pending.push(eventId);
  if (!q.busy) void drainQueue(handlerId);
}

async function drainQueue(handlerId: string): Promise<void> {
  const q = getQueue(handlerId);
  if (q.busy) return;
  q.busy = true;
  try {
    while (q.pending.length > 0) {
      const eventId = q.pending.shift()!;
      await processOne(handlerId, eventId);
    }
  } finally {
    q.busy = false;
  }
}

function pairKey(eventId: string, handlerId: string): string {
  return `${eventId}:${handlerId}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as NodeJS.Timeout).unref?.();
  });
}

let callIdCounter = 0;
function nextCallId(): string {
  callIdCounter += 1;
  return `evt-call-${Date.now()}-${callIdCounter}`;
}

async function invoke(reg: HandlerRegistration, record: EventRecord, callId: string): Promise<void> {
  if (reg.declaredBy === "core") {
    const fn = state().coreExecutors.get(reg.handlerId);
    if (!fn) throw new Error(`no core executor registered for handler "${reg.handlerId}"`);
    const out = await fn(record);
    settleAck(record.id, reg.handlerId, (out as { result?: unknown } | undefined)?.result, undefined, callId);
    return;
  }
  const invoker = state().serviceInvoker;
  if (!invoker) throw new Error("no service handler invoker wired up — this is a BOS bug");
  await invoker(reg.ownerId, reg.handlerId, record, reg.timeoutMs, callId);
}

/** Fires the invocation and waits for either an external settleAck() call
 *  (via the public ack API) or the handler's timeout. */
function invokeAndWait(reg: HandlerRegistration, record: EventRecord): Promise<{ ok: true } | { ok: false; error: string }> {
  const key = pairKey(record.id, reg.handlerId);
  const callId = nextCallId();
  const pendingByPair = state().pendingByPair;
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      pendingByPair.delete(key);
      resolve({ ok: false, error: `timed out after ${reg.timeoutMs}ms` });
    }, reg.timeoutMs);
    (timer as NodeJS.Timeout).unref?.();

    pendingByPair.set(key, {
      callId,
      resolve: (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pendingByPair.delete(key);
        resolve(v);
      },
    });

    invoke(reg, record, callId).catch((err: Error) => {
      const waiter = pendingByPair.get(key);
      if (waiter) waiter.resolve({ ok: false, error: err.message });
    });
  });
}

async function processOne(handlerId: string, eventId: string): Promise<void> {
  const reg0 = store.getHandler(handlerId);
  if (!reg0 || !isHandlerActive(reg0)) return; // dropped — reevaluateCompletion handles it elsewhere
  const record = await store.getEventBody(eventId);
  if (!record) return;

  let attempt = store.getEventState(eventId)?.perHandler[handlerId]?.attempts ?? 0;
  while (attempt < MAX_HANDLER_ATTEMPTS) {
    const liveReg = store.getHandler(handlerId);
    if (!liveReg || !isHandlerActive(liveReg)) return;

    const current = store.getEventState(eventId)?.perHandler[handlerId];
    if (current?.status === "acked" || current?.status === "permanently_failed") return;

    attempt += 1;
    store.updateEventState(eventId, (s) => {
      s.perHandler[handlerId] = { status: "pending", attempts: attempt, lastError: s.perHandler[handlerId]?.lastError };
    });

    const result = await invokeAndWait(liveReg, record);
    if (result.ok) return; // settleAck() already recorded the ack + reevaluated completion

    const isFinal = attempt >= MAX_HANDLER_ATTEMPTS;
    store.updateEventState(eventId, (s) => {
      s.perHandler[handlerId] = { status: isFinal ? "permanently_failed" : "pending", attempts: attempt, lastError: result.error };
      s.history.push({
        eventId,
        handlerId,
        appId: liveReg.ownerId,
        attempt,
        ts: Date.now(),
        status: isFinal ? "permanently_failed" : "failed",
        error: result.error,
      });
    });
    publish({ kind: "handlers", eventId, handlerId, eventType: record.type });
    if (isFinal) {
      reevaluateCompletion(eventId);
      return;
    }
    const backoffMs = state().backoffMs;
    await sleep(backoffMs[Math.min(attempt - 1, backoffMs.length - 1)]);
  }
}

// ── Ack settlement (called by api.ts's ack(), and internally for core handlers) ──

export type AckOutcome =
  | { kind: "ok"; processing: "pending" | "processed"; attempts: number }
  | { kind: "duplicate"; processing: "pending" | "processed"; attempts: number }
  | { kind: "conflict" }
  | { kind: "not-found" };

/** `callId`, when provided (an IPC-dispatched service ack — R010/T028's
 *  exactly-once-settle guard), must match the attempt currently outstanding
 *  for this (event, handler) pair. A mismatch means this ack is for an
 *  attempt already superseded by a retry (the original timed out and a new
 *  attempt started before this late ack arrived) — treated as a no-op
 *  duplicate rather than incorrectly settling the new, unrelated attempt.
 *  In-process/core callers omit `callId` and settle on the pair alone. */
export function settleAck(eventId: string, handlerId: string, result: unknown, ownerId?: string, callId?: string): AckOutcome {
  const st = store.getEventState(eventId);
  if (!st) return { kind: "not-found" };
  const existing = st.perHandler[handlerId];
  if (existing?.status === "acked") return { kind: "duplicate", processing: st.processing, attempts: existing.attempts };
  if (existing?.status === "permanently_failed") return { kind: "conflict" };

  const waiter = state().pendingByPair.get(pairKey(eventId, handlerId));
  if (callId && waiter && waiter.callId !== callId) {
    return { kind: "duplicate", processing: st.processing, attempts: existing?.attempts ?? 0 };
  }

  const attempt = existing?.attempts ?? 1;
  const reg = store.getHandler(handlerId);
  store.updateEventState(eventId, (s) => {
    s.perHandler[handlerId] = { status: "acked", attempts: attempt };
    s.history.push({
      eventId,
      handlerId,
      appId: ownerId ?? reg?.ownerId ?? "",
      attempt,
      ts: Date.now(),
      status: "acked",
      result,
    });
  });
  publish({ kind: "handlers", eventId, handlerId, eventType: store.getIndexEntry(eventId)?.type });
  reevaluateCompletion(eventId);

  if (waiter) waiter.resolve({ ok: true });

  const after = store.getEventState(eventId)!;
  return { kind: "ok", processing: after.processing, attempts: attempt };
}

// ── Completion evaluation (data-model §6.1) ─────────────────────────────────

export function reevaluateCompletion(eventId: string): void {
  const st = store.getEventState(eventId);
  if (!st || st.processing === "processed") return;
  const entry = store.getIndexEntry(eventId);
  if (!entry) return;

  const active = activeHandlersForType(entry.type);
  if (active.length === 0) {
    store.updateEventState(eventId, (s) => {
      s.processing = "processed";
      s.processedReason = "no-active-handlers";
    });
    publish({ kind: "processing", eventId, eventType: entry.type, processing: "processed" });
    return;
  }

  const allSettled = active.every((h) => {
    const ph = st.perHandler[h.handlerId];
    return ph && (ph.status === "acked" || ph.status === "permanently_failed");
  });
  if (!allSettled) return;

  const anyFailed = active.some((h) => st.perHandler[h.handlerId]?.status === "permanently_failed");
  store.updateEventState(eventId, (s) => {
    s.processing = "processed";
    s.processedReason = anyFailed ? "all-settled-with-failures" : "all-acked";
  });
  publish({ kind: "processing", eventId, eventType: entry.type, processing: "processed" });
}

// ── Entry points used by kernel.ts ──────────────────────────────────────────

/** Called right after a new event's durable body + initial state exist.
 *  Enqueuing is synchronous (fire-and-forget); the emit path never awaits
 *  handler completion (FR-004). */
export function dispatchEmittedEvent(record: EventRecord, activeHandlerIds: string[]): void {
  for (const handlerId of activeHandlerIds) enqueue(handlerId, record.id);
}

/** At-least-once re-dispatch on boot (FR-005a): every pending event is
 *  re-enqueued to every currently-active handler that hasn't settled. */
export function redispatchPendingOnBoot(): void {
  for (const entry of store.listPending()) {
    const st = store.getEventState(entry.id);
    if (!st) continue;
    for (const h of activeHandlersForType(entry.type)) {
      const ph = st.perHandler[h.handlerId];
      if (ph?.status === "acked" || ph?.status === "permanently_failed") continue;
      enqueue(h.handlerId, entry.id);
    }
  }
}

/** Late-registration catch-up (FR-005b): re-dispatch pending events of this
 *  handler's type that it hasn't settled yet. */
export function catchUpHandler(reg: HandlerRegistration): void {
  if (!isHandlerActive(reg)) return;
  for (const entry of store.listPending()) {
    if (!typeMatches(reg.eventType, entry.type)) continue;
    const ph = store.getEventState(entry.id)?.perHandler[reg.handlerId];
    if (ph?.status === "acked" || ph?.status === "permanently_failed") continue;
    enqueue(reg.handlerId, entry.id);
  }
}

/** Re-evaluate every pending event — call after a handler becomes inactive
 *  (disabled/uninstalled/service stopped), which may unblock completion
 *  (FR-019/FR-020). */
export function reevaluateAllPending(): void {
  for (const entry of store.listPending()) reevaluateCompletion(entry.id);
}

/** Test-only: forget all queues/waiters between tests. */
export function _resetDispatchForTests(): void {
  g.__bosEventDispatch = {
    ownerRunningCheck: () => false,
    serviceInvoker: null,
    coreExecutors: new Map(),
    backoffMs: RETRY_BACKOFF_MS,
    queues: new Map(),
    pendingByPair: new Map(),
  };
}
