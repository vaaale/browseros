import "server-only";
import * as kernel from "./kernel";
import * as store from "./store";
import {
  EventApiError,
  MAX_PAYLOAD_BYTES,
  DEFAULT_HANDLER_TIMEOUT_MS,
  isValidEventType,
  isValidRegistrationType,
  ownsNamespace,
} from "./types";
import type { EventFullView, EventRecord, HandlerMode, HandlerRegistration } from "./types";

// The public event API (ADR-2) — ONE contract, reached by three transports:
// in-process (agent tools, core code — this module directly), same-origin
// HTTP (the Event Viewer + bell, via src/app/api/events/*), and loopback HTTP
// (worker-thread services, via src/lib/events/loopback.ts). This module adds
// request validation (payload size, type shape, namespace ownership) on top
// of kernel.ts's business logic, and is what every transport delegates to.

export interface EmitRequest {
  type: string;
  payload: Record<string, unknown>;
  source: { appId: string; name: string; icon?: string };
}

function payloadByteSize(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload ?? {}), "utf8");
}

export async function emit(req: EmitRequest): Promise<kernel.EmitResult> {
  if (!isValidEventType(req.type)) {
    throw new EventApiError("invalid-type", `"${req.type}" is not a valid event type (dot-separated, lowercase, ≤256 chars)`);
  }
  if (typeof req.payload !== "object" || req.payload === null) {
    throw new EventApiError("invalid-type", "payload must be a JSON object");
  }
  if (payloadByteSize(req.payload) > MAX_PAYLOAD_BYTES) {
    throw new EventApiError("payload-too-large", "payload exceeds 1MB — use a VFS path reference for large data");
  }
  if (!req.source || typeof req.source.appId !== "string" || !req.source.appId) {
    throw new EventApiError("invalid-type", "source.appId is required");
  }
  return kernel.emit({ type: req.type, payload: req.payload, source: req.source });
}

export function query(filter: store.QueryFilter): store.QueryResult {
  return kernel.query(filter);
}

export async function getEvent(id: string): Promise<EventFullView> {
  const full = await kernel.getEventFull(id);
  if (!full) throw new EventApiError("not-found", `unknown event "${id}"`);
  return full;
}

export interface AckRequest {
  handlerId: string;
  result?: unknown;
  callerId: string;
  callId?: string;
}

export function ack(eventId: string, req: AckRequest): kernel.AckResult {
  if (!req.handlerId) throw new EventApiError("not-found", "handlerId is required");
  return kernel.ack(eventId, { handlerId: req.handlerId, result: req.result, callerId: req.callerId, callId: req.callId });
}

export function markRead(eventId: string): { read: "read"; unreadTotal: number } {
  return kernel.markRead(eventId);
}

export function markAllRead(): { marked: number; unreadTotal: number } {
  return kernel.markAllRead();
}

export interface RegisterRequest {
  handlerId: string;
  eventType: string;
  mode: HandlerMode;
  ownerId: string;
  displayName: string;
  description?: string;
  icon?: string;
  timeoutMs?: number;
  enabled?: boolean;
  declaredBy?: HandlerRegistration["declaredBy"];
  launch?: HandlerRegistration["launch"];
  /** Explicit grant list — skips the best-effort registry lookup when the
   *  caller already has the owner's manifest/service.json in hand. */
  grantedNamespaces?: string[];
}

/** Resolves an owner's statically-granted `eventNamespaces` (FR-023) from its
 *  built-in manifest, installed-app manifest, or service.json — whichever
 *  matches `ownerId`. Best-effort: any lookup failure (e.g. this module used
 *  outside a full BOS boot, as in unit tests) yields no grants, which still
 *  lets the owned-root check (`com.bos.<ownerId>.*`) succeed on its own. */
async function resolveGrantedNamespaces(ownerId: string): Promise<string[]> {
  try {
    const { BUILTIN_APPS } = await import("@/os/apps");
    const builtin = BUILTIN_APPS.find((a) => a.id === ownerId) as { eventNamespaces?: string[] } | undefined;
    if (builtin?.eventNamespaces?.length) return builtin.eventNamespaces;
  } catch {
    // ignore — not available in this execution context
  }
  try {
    const { listInstalledManifests } = await import("@/lib/apps/store");
    const installed = (await listInstalledManifests()).find((a) => a.id === ownerId) as
      | { eventNamespaces?: string[] }
      | undefined;
    if (installed?.eventNamespaces?.length) return installed.eventNamespaces;
  } catch {
    // ignore
  }
  try {
    const { serviceRegistry } = await import("@/core/service/ServiceRegistry");
    const svc = serviceRegistry().getService(ownerId);
    const ns = (svc?.manifest as { eventNamespaces?: string[] } | undefined)?.eventNamespaces;
    if (ns?.length) return ns;
  } catch {
    // ignore
  }
  return [];
}

export async function register(req: RegisterRequest): Promise<HandlerRegistration> {
  if (!req.handlerId) throw new EventApiError("invalid-type", "handlerId is required");
  if (!isValidRegistrationType(req.eventType)) {
    throw new EventApiError("invalid-type", `"${req.eventType}" is not a valid event type or "prefix.*" pattern`);
  }
  if (req.mode !== "headless" && req.mode !== "ui") {
    throw new EventApiError("invalid-type", `mode must be "headless" or "ui"`);
  }
  if (!req.ownerId) throw new EventApiError("invalid-type", "ownerId is required");

  // A caller that already has the owner's manifest/service.json in hand
  // (register-ui-handlers.ts, ServiceManager's handler_declare wiring) can
  // pass its grants directly — skipping the best-effort registry lookups
  // below, which only work for a caller CURRENTLY discoverable in the app/
  // service registries (irrelevant here since the manifest is already proof).
  const grants = req.grantedNamespaces ?? (await resolveGrantedNamespaces(req.ownerId));
  if (!ownsNamespace(req.eventType, req.ownerId, grants)) {
    throw new EventApiError(
      "namespace-not-owned",
      `"${req.ownerId}" may not register handlers for "${req.eventType}" — outside its owned root (com.bos.${req.ownerId}.*) and granted namespaces`,
    );
  }

  // Re-registering the same handlerId is an idempotent upsert (contract §6):
  // preserve a previously-set `enabled` (e.g. the user disabled it in
  // Configuration) across a service restart's re-declare, unless the caller
  // explicitly passes `enabled`.
  const existing = store.getHandler(req.handlerId);
  const reg: HandlerRegistration = {
    handlerId: req.handlerId,
    eventType: req.eventType,
    mode: req.mode,
    ownerId: req.ownerId,
    displayName: req.displayName || req.handlerId,
    description: req.description,
    icon: req.icon,
    enabled: req.enabled ?? existing?.enabled ?? true,
    timeoutMs: req.timeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS,
    declaredBy: req.declaredBy ?? (req.mode === "ui" ? "manifest" : "service"),
    launch: req.launch,
  };
  return kernel.register(reg);
}

export async function unregister(handlerId: string, ownerId: string): Promise<void> {
  return kernel.unregister(handlerId, ownerId);
}

export async function setPreference(eventType: string, preferredHandlerId: string | null) {
  return kernel.setPreference(eventType, preferredHandlerId);
}

export function count(): { unreadTotal: number; pendingTotal: number; grandTotal: number } {
  return kernel.count();
}

export function listHandlersGrouped(): Record<string, kernel.HandlerGroup> {
  return kernel.listHandlersGrouped();
}

export async function setEnabled(handlerId: string, ownerId: string, enabled: boolean): Promise<HandlerRegistration> {
  return kernel.setEnabled(handlerId, ownerId, enabled);
}

export type { EventRecord };
