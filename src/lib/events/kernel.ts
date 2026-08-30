import "server-only";
import * as store from "./store";
import * as dispatch from "./dispatch";
import { publish } from "./stream";
import { deriveSummary, typeMatches, EventApiError } from "./types";
import type { EventRecord, EventFullView, HandlerRegistration, HandlerPreference } from "./types";

// The event kernel — a globalThis singleton daemon (design.md §3.3, ADR-1),
// sibling to the scheduler daemon (src/lib/scheduler/daemon.ts). Owns the
// two-axis state machine (processing pending→processed; read unread→read),
// boot re-dispatch, and every public operation (emit/ack/query/register/
// unregister/markRead/setPreference/count/listHandlers/setEnabled). This is
// what src/lib/events/api.ts (input validation) and the HTTP routes delegate to.

const g = globalThis as unknown as { __bosEventKernelStarted?: boolean };

export async function startEventKernel(): Promise<void> {
  if (g.__bosEventKernelStarted) return;
  await store.initStore();
  dispatch.redispatchPendingOnBoot();
  g.__bosEventKernelStarted = true;
}

export function isKernelStarted(): boolean {
  return !!g.__bosEventKernelStarted;
}

/** Graceful shutdown — flushes the warm index/state to disk. */
export async function stopEventKernel(): Promise<void> {
  await store.shutdownStore();
  g.__bosEventKernelStarted = false;
}

// ── emit (FR-002/003/004/008) ────────────────────────────────────────────

export interface EmitInput {
  type: string;
  payload: Record<string, unknown>;
  source: EventRecord["source"];
}

export interface EmitResult {
  id: string;
  sequence: number;
  ts: number;
  processing: "pending" | "processed";
  read: "unread";
  activeHandlers: number;
}

export async function emit(input: EmitInput): Promise<EmitResult> {
  // Guards against a caller (e.g. a service's very first handler_declare, or
  // an emit racing boot) reaching the store before startEventKernel() has run
  // — initStore() is itself idempotent, so this is a cheap no-op once booted.
  await store.initStore();
  const summary = deriveSummary(input.payload);
  const record = await store.appendEvent({ type: input.type, payload: input.payload, source: input.source, summary });

  const active = dispatch.activeHandlersForType(record.type);
  if (active.length === 0) {
    // R8 — no active handlers ⇒ immediately processed.
    store.updateEventState(record.id, (s) => {
      s.processing = "processed";
      s.processedReason = "no-active-handlers";
    });
  }

  publish({ kind: "new", eventId: record.id, eventType: record.type });
  if (active.length > 0) {
    dispatch.dispatchEmittedEvent(record, active.map((h) => h.handlerId));
  } else {
    publish({ kind: "processing", eventId: record.id, eventType: record.type, processing: "processed" });
  }

  const st = store.getEventState(record.id)!;
  return {
    id: record.id,
    sequence: record.sequence,
    ts: record.ts,
    processing: st.processing,
    read: "unread",
    activeHandlers: active.length,
  };
}

// ── query / get ──────────────────────────────────────────────────────────

export function query(filter: store.QueryFilter): store.QueryResult {
  return store.query(filter);
}

export async function getEventFull(id: string): Promise<EventFullView | undefined> {
  const entry = store.getIndexEntry(id);
  const st = store.getEventState(id);
  const body = await store.getEventBody(id);
  if (!entry || !st || !body) return undefined;
  return { ...entry, payload: body.payload, history: st.history };
}

// ── ack (FR-005/006/007/022) ─────────────────────────────────────────────

export interface AckInput {
  handlerId: string;
  result?: unknown;
  callerId: string;
  /** Exactly-once-settle guard for IPC-dispatched service handlers (T028) —
   *  omitted by in-process/core callers. */
  callId?: string;
}

export interface AckResult {
  settled: boolean;
  processing: "pending" | "processed";
  attempts: number;
}

export function ack(eventId: string, input: AckInput): AckResult {
  const reg = store.getHandler(input.handlerId);
  if (!reg) throw new EventApiError("not-found", `unknown handler "${input.handlerId}"`);
  if (reg.ownerId !== input.callerId) {
    throw new EventApiError("ack-forbidden", `"${input.callerId}" does not own handler "${input.handlerId}"`);
  }
  const outcome = dispatch.settleAck(eventId, input.handlerId, input.result, input.callerId, input.callId);
  if (outcome.kind === "not-found") throw new EventApiError("not-found", `unknown event "${eventId}"`);
  if (outcome.kind === "conflict") {
    throw new EventApiError(
      "already-settled",
      `handler "${input.handlerId}" already permanently failed for event "${eventId}"`,
    );
  }
  return { settled: true, processing: outcome.processing, attempts: outcome.attempts };
}

// ── read state (FR-009 through FR-012) ──────────────────────────────────

export function markRead(eventId: string): { read: "read"; unreadTotal: number } {
  const st = store.updateEventState(eventId, (s) => {
    s.read = "read";
  });
  if (!st) throw new EventApiError("not-found", `unknown event "${eventId}"`);
  publish({ kind: "read", eventId, read: "read" });
  return { read: "read", unreadTotal: store.unreadCount() };
}

export function markAllRead(): { marked: number; unreadTotal: number } {
  let marked = 0;
  for (const e of store.listAll()) {
    if (e.read !== "unread") continue;
    store.updateEventState(e.id, (s) => {
      s.read = "read";
    });
    marked++;
  }
  if (marked > 0) publish({ kind: "read", read: "read" });
  return { marked, unreadTotal: store.unreadCount() };
}

// ── register / unregister (FR-013/023) ──────────────────────────────────

export async function register(reg: HandlerRegistration): Promise<HandlerRegistration> {
  await store.initStore(); // see comment in emit() — handler_declare can race boot
  await store.putHandler(reg);
  publish({ kind: "handlers", handlerId: reg.handlerId, eventType: reg.eventType });
  if (reg.mode === "headless") dispatch.catchUpHandler(reg);
  return reg;
}

export async function unregister(handlerId: string, ownerId: string): Promise<void> {
  await store.initStore();
  const existing = store.getHandler(handlerId);
  if (!existing) return;
  if (existing.ownerId !== ownerId) {
    throw new EventApiError("ack-forbidden", `"${ownerId}" does not own handler "${handlerId}"`);
  }
  await store.removeHandler(handlerId);
  publish({ kind: "handlers", handlerId, eventType: existing.eventType });
  if (existing.mode === "headless") dispatch.reevaluateAllPending();
}

// ── handler enable/disable (FR-018/019) ─────────────────────────────────

export async function setEnabled(handlerId: string, ownerId: string, enabled: boolean): Promise<HandlerRegistration> {
  await store.initStore();
  const reg = store.getHandler(handlerId);
  if (!reg) throw new EventApiError("not-found", `unknown handler "${handlerId}"`);
  if (reg.mode !== "headless") {
    throw new EventApiError("invalid-type", `"${handlerId}" is a UI handler — only headless handlers can be enabled/disabled`);
  }
  if (reg.ownerId !== ownerId) {
    throw new EventApiError("ack-forbidden", `"${ownerId}" does not own handler "${handlerId}"`);
  }
  const updated: HandlerRegistration = { ...reg, enabled };
  await store.putHandler(updated);
  publish({ kind: "handlers", handlerId, eventType: reg.eventType });
  if (enabled) dispatch.catchUpHandler(updated);
  else dispatch.reevaluateAllPending();
  return updated;
}

/** Called by the ServiceManager lifecycle wiring when a service's worker
 *  stops/crashes — its headless handlers stop being "active" without being
 *  removed, so pending events waiting on them may now be completable. */
export function reevaluateAfterOwnerStopped(): void {
  dispatch.reevaluateAllPending();
}

/** Called when a (re)started service posts handler_declare — late
 *  registration catch-up (FR-005b) happens via register() already; this is
 *  for the case a handler's owner comes back WITHOUT re-registering (its
 *  registration already existed in handlers.json from a prior boot). */
export function reevaluateAfterOwnerStarted(ownerId: string): void {
  for (const reg of store.listHandlers()) {
    if (reg.ownerId === ownerId && reg.mode === "headless") dispatch.catchUpHandler(reg);
  }
}

// ── preferences (FR-010/016/027) ────────────────────────────────────────

export async function setPreference(eventType: string, preferredHandlerId: string | null): Promise<HandlerPreference | null> {
  if (preferredHandlerId) {
    const reg = store.getHandler(preferredHandlerId);
    if (!reg || reg.mode !== "ui" || !typeMatches(reg.eventType, eventType)) {
      throw new EventApiError("invalid-preference", `"${preferredHandlerId}" is not a UI handler registered for "${eventType}"`);
    }
  }
  await store.setPreference(eventType, preferredHandlerId);
  return preferredHandlerId ? (store.getPreference(eventType) ?? null) : null;
}

export function getPreference(eventType: string): HandlerPreference | undefined {
  return store.getPreference(eventType);
}

// ── count (bell, FR-009/ADR-6) ───────────────────────────────────────────

export function count(): { unreadTotal: number; pendingTotal: number; grandTotal: number } {
  return { unreadTotal: store.unreadCount(), pendingTotal: store.pendingCount(), grandTotal: store.totalCount() };
}

// ── configuration (FR-018) ───────────────────────────────────────────────

export interface HeadlessHandlerView {
  handlerId: string;
  displayName: string;
  icon?: string;
  enabled: boolean;
  timeoutMs: number;
  recentFailures: number;
  ownerId: string;
}
export interface UiHandlerView {
  handlerId: string;
  displayName: string;
  icon?: string;
  description?: string;
  isDefault: boolean;
  ownerId: string;
  launch?: HandlerRegistration["launch"];
}
export interface HandlerGroup {
  headless: HeadlessHandlerView[];
  ui: UiHandlerView[];
}

export function listHandlersGrouped(): Record<string, HandlerGroup> {
  const month = store.currentMonthKey();
  const out: Record<string, HandlerGroup> = {};
  for (const reg of store.listHandlers()) {
    if (!out[reg.eventType]) out[reg.eventType] = { headless: [], ui: [] };
    if (reg.mode === "headless") {
      out[reg.eventType].headless.push({
        handlerId: reg.handlerId,
        displayName: reg.displayName,
        icon: reg.icon,
        enabled: reg.enabled,
        timeoutMs: reg.timeoutMs,
        recentFailures: store.countHandlerFailuresInMonth(reg.handlerId, month),
        ownerId: reg.ownerId,
      });
    } else {
      const pref = store.getPreference(reg.eventType);
      out[reg.eventType].ui.push({
        handlerId: reg.handlerId,
        displayName: reg.displayName,
        icon: reg.icon,
        description: reg.description,
        isDefault: pref?.preferredHandlerId === reg.handlerId,
        ownerId: reg.ownerId,
        launch: reg.launch,
      });
    }
  }
  return out;
}

export function listHandlersForType(eventType: string): HandlerRegistration[] {
  return store.listHandlersForType(eventType);
}

/** Test-only: forget the "started" flag so a fresh store root gets a fresh
 *  boot sequence (initStore + redispatchPendingOnBoot) on the next test. */
export function _resetKernelForTests(): void {
  g.__bosEventKernelStarted = false;
}
