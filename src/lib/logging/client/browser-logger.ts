"use client";

import { getSessionId } from "@/lib/logging/client/session";
import type { LogLevel } from "@/lib/logging/models/log-models";

// Batched browser logger. Buffers records and ships them to the Supervisor (the
// always-on sink) as NDJSON-friendly JSON batches, flushing on an interval, on a
// size threshold, and via sendBeacon on pagehide. Captures uncaught errors,
// unhandled rejections, and console.error. Fire-and-forget: never throws.
// See specs/017-central-logging.

interface ClientRecord {
  ts: number;
  level: LogLevel;
  stream: "frontend";
  component: string;
  msg: string;
  sessionId: string;
  data?: unknown;
  err?: { message: string; stack?: string };
}

const FLUSH_INTERVAL_MS = 2_000;
const FLUSH_AT = 50; // flush eagerly once the buffer reaches this many records
const MAX_QUEUE = 1_000; // hard cap so a logging storm can't grow unbounded

let buffer: ClientRecord[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
// Posting directly to the Supervisor is resilient even if this version's server is
// wedged. `/api/logs` is the safe default (it forwards to the Supervisor when present)
// until the probe upgrades us to the direct endpoint.
let target = "/api/logs";
let started = false;

function toErr(err: unknown): { message: string; stack?: string } | undefined {
  if (err === undefined || err === null) return undefined;
  if (err instanceof Error) return { message: err.message, ...(err.stack ? { stack: err.stack } : {}) };
  return { message: stringifyArg(err) };
}

function stringifyArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack || a.message;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

export function clog(level: LogLevel, component: string, msg: string, data?: unknown, err?: unknown): void {
  try {
    buffer.push({
      ts: Date.now(),
      level,
      stream: "frontend",
      component,
      msg: String(msg).slice(0, 8000),
      sessionId: getSessionId(),
      ...(data !== undefined ? { data } : {}),
      ...(err ? { err: toErr(err) } : {}),
    });
    if (buffer.length > MAX_QUEUE) buffer = buffer.slice(-MAX_QUEUE);
    if (buffer.length >= FLUSH_AT) void flush();
    else schedule();
  } catch {
    /* never throw from logging */
  }
}

function schedule(): void {
  if (timer) return;
  timer = setTimeout(() => void flush(), FLUSH_INTERVAL_MS);
}

async function flush(useBeacon = false): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (buffer.length === 0) return;
  const batch = buffer;
  buffer = [];
  const body = JSON.stringify({ records: batch });
  try {
    if (useBeacon && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon(target, new Blob([body], { type: "application/json" }));
      return;
    }
    const res = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-bos-session": getSessionId() },
      body,
      keepalive: useBeacon,
    });
    if (!res.ok) throw new Error(`ingest ${res.status}`);
  } catch {
    // Re-buffer a bounded tail so a transient outage doesn't lose everything.
    buffer = [...batch.slice(-FLUSH_AT), ...buffer].slice(-MAX_QUEUE);
  }
}

// If the Supervisor control surface answers, post logs straight to it (survives a
// broken version server). Otherwise keep the /api/logs fallback.
async function resolveTarget(): Promise<void> {
  try {
    const res = await fetch("/__supervisor/state", { cache: "no-store" });
    if (res.ok) target = "/__supervisor/logs";
  } catch {
    /* keep /api/logs */
  }
}

/** Install global capture + flush handlers. Returns a teardown function. */
export function startBrowserLogging(): () => void {
  if (started || typeof window === "undefined") return () => {};
  started = true;
  void resolveTarget();

  const onError = (e: ErrorEvent) =>
    clog("error", "window.onerror", e.message || "uncaught error", { filename: e.filename, lineno: e.lineno, colno: e.colno }, e.error);
  const onRejection = (e: PromiseRejectionEvent) => clog("error", "unhandledrejection", "unhandled promise rejection", undefined, e.reason);
  const onVisibility = () => {
    if (document.visibilityState === "hidden") void flush(true);
  };
  const onPageHide = () => void flush(true);

  // Mirror console.error into the timeline (most app-level errors land there).
  const originalError = console.error.bind(console);
  const patchedError = (...args: unknown[]) => {
    try {
      clog("error", "console.error", args.map(stringifyArg).join(" "));
    } catch {
      /* ignore */
    }
    originalError(...args);
  };
  console.error = patchedError;

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPageHide);

  clog("info", "client", "browser logging started", { ua: navigator.userAgent });

  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", onPageHide);
    if (console.error === patchedError) console.error = originalError;
    void flush(true);
    started = false;
  };
}
