// Framework-free shared types for the Event & Notification System
// (034-event-notification-system). Imported by both server-only kernel code
// and client code (the Event Viewer, the bell) — no React, no Node imports.
// See specs/user-specs/core-platform/034-event-notification-system/data-model.md.

export type ProcessingStatus = "pending" | "processed";
export type ReadStatus = "unread" | "read";
export type HandlerMode = "headless" | "ui";
export type ProcessedReason = "all-acked" | "no-active-handlers" | "all-settled-with-failures";
export type AckStatus = "acked" | "failed" | "permanently_failed";
export type DeclaredBy = "service" | "manifest" | "core";

export interface EventSource {
  appId: string;
  name: string;
  icon?: string;
}

/** Immutable — appended once to a per-month JSONL shard, never rewritten. */
export interface EventRecord {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  source: EventSource;
  ts: number;
  /** Per-type monotonic (R7). */
  sequence: number;
  summary: string;
}

export interface HandlerAcknowledgment {
  eventId: string;
  handlerId: string;
  appId: string;
  attempt: number;
  ts: number;
  status: AckStatus;
  result?: unknown;
  error?: string;
}

export interface PerHandlerState {
  status: "pending" | "acked" | "permanently_failed";
  attempts: number;
  lastError?: string;
}

/** Mutable — one per event, lives in the per-month state file (+ warm memory). */
export interface EventState {
  eventId: string;
  processing: ProcessingStatus;
  processedReason?: ProcessedReason;
  read: ReadStatus;
  history: HandlerAcknowledgment[];
  perHandler: Record<string, PerHandlerState>;
}

export interface HandlerLaunch {
  appId: string;
  componentHint?: string;
}

export interface HandlerRegistration {
  handlerId: string;
  /** Exact type or a "prefix.*" namespace pattern. */
  eventType: string;
  mode: HandlerMode;
  ownerId: string;
  displayName: string;
  description?: string;
  icon?: string;
  /** User-controllable, headless only. Always true for UI handlers. */
  enabled: boolean;
  timeoutMs: number;
  declaredBy: DeclaredBy;
  launch?: HandlerLaunch;
}

export interface HandlerPreference {
  eventType: string;
  preferredHandlerId: string;
  ts: number;
}

/** One row in a query() list response — denormalized for fast rendering. */
export interface EventSummaryView {
  id: string;
  type: string;
  sequence: number;
  ts: number;
  source: EventSource;
  summary: string;
  processing: ProcessingStatus;
  processedReason?: ProcessedReason;
  read: ReadStatus;
  handlersTotal: number;
  handlersDone: number;
}

/** Full event: body + state + history — the `get` / detail-view shape. */
export interface EventFullView extends EventSummaryView {
  payload: Record<string, unknown>;
  history: HandlerAcknowledgment[];
}

export type StreamEventKind = "new" | "processing" | "read" | "handlers";

export interface StreamEvent {
  streamSeq: number;
  kind: StreamEventKind;
  ts: number;
  eventId?: string;
  eventType?: string;
  processing?: ProcessingStatus;
  read?: ReadStatus;
  handlerId?: string;
}

export type EventErrorCode =
  | "invalid-type"
  | "payload-too-large"
  | "namespace-not-owned" // retired by 037 (Event Namespace Relaxation) — never thrown; kept for compatibility
  | "ack-forbidden"
  | "already-settled"
  | "invalid-preference"
  | "not-found";

const STATUS_BY_CODE: Record<EventErrorCode, number> = {
  "invalid-type": 400,
  "payload-too-large": 413,
  "namespace-not-owned": 403,
  "ack-forbidden": 403,
  "already-settled": 409,
  "invalid-preference": 400,
  "not-found": 404,
};

/** Uniform error envelope used across all three transports (ADR-2). */
export class EventApiError extends Error {
  code: EventErrorCode;
  status: number;

  constructor(code: EventErrorCode, message: string) {
    super(message);
    this.name = "EventApiError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}

export const MAX_PAYLOAD_BYTES = 1024 * 1024; // 1MB (FR-024)
export const MAX_TYPE_LENGTH = 256; // NFR-005
export const DEFAULT_HANDLER_TIMEOUT_MS = 30_000; // NFR-006
export const RETRY_BACKOFF_MS = [1000, 5000, 30000] as const; // FR-007
export const MAX_HANDLER_ATTEMPTS = 3;

const TYPE_PATTERN = /^[a-z0-9]+(\.[a-z0-9_-]+)+$/;
const REGISTRATION_TYPE_PATTERN = /^[a-z0-9]+(\.[a-z0-9_-]+)*\.\*$/;

export function isValidEventType(type: unknown): type is string {
  return typeof type === "string" && type.length > 0 && type.length <= MAX_TYPE_LENGTH && TYPE_PATTERN.test(type);
}

/** A handler registration's `eventType` may be an exact type OR a
 *  "prefix.*" namespace pattern (data-model §4). */
export function isValidRegistrationType(type: unknown): type is string {
  if (typeof type !== "string" || type.length === 0 || type.length > MAX_TYPE_LENGTH) return false;
  return TYPE_PATTERN.test(type) || REGISTRATION_TYPE_PATTERN.test(type);
}

/** True if `handlerType` (an exact type or a "prefix.*" pattern) matches `eventType`. */
export function typeMatches(handlerType: string, eventType: string): boolean {
  if (handlerType === eventType) return true;
  if (handlerType.endsWith(".*")) {
    const prefix = handlerType.slice(0, -1); // keep trailing "."
    return eventType.startsWith(prefix);
  }
  return false;
}

export function deriveSummary(payload: Record<string, unknown>): string {
  if (payload && typeof payload.summary === "string" && payload.summary.trim()) {
    return payload.summary.slice(0, 140);
  }
  try {
    const str = JSON.stringify(payload ?? {});
    return str.length > 140 ? `${str.slice(0, 140)}…` : str;
  } catch {
    return "";
  }
}
