import "server-only";

// Worker-thread services reach the public event API via plain loopback HTTP
// to BOS's own API (design.md §3.6, R1/R2) — the same pattern already used
// for /api/fs and /api/secrets/<service>/verify. There is no new auth
// mechanism: the caller declares its own id (`callerId`/`ownerId`) in the
// request body, and the kernel's ownership/namespace checks are a
// same-container integrity guard, not a network security boundary (single-
// container trust model, design.md §3.5).

function baseUrl(): string {
  // The worker is spawned by the same Node process that serves HTTP, so its
  // own env carries the serving port (R2). Falls back to Next's dev default.
  const port = process.env.PORT || "3000";
  return `http://127.0.0.1:${port}`;
}

interface ApiError {
  error?: { code: string; message: string };
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as T & ApiError;
  if (!res.ok) {
    throw new Error(body?.error?.message ?? `event API request to ${path} failed with HTTP ${res.status}`);
  }
  return body;
}

export interface EmitInput {
  type: string;
  payload: Record<string, unknown>;
  source: { appId: string; name: string; icon?: string };
}

export function emitEvent(input: EmitInput) {
  return call<{ id: string; sequence: number; ts: number; processing: string; read: string; activeHandlers: number }>(
    "/api/events",
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function ackEvent(eventId: string, input: { handlerId: string; result?: unknown; callerId: string; callId?: string }) {
  return call<{ settled: boolean; processing: string; attempts: number }>(
    `/api/events/${encodeURIComponent(eventId)}/ack`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function queryEvents(params: Record<string, string | number | undefined> = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
  const suffix = qs.toString();
  return call<{ events: unknown[]; nextCursor: string | null; unreadTotal: number }>(
    `/api/events${suffix ? `?${suffix}` : ""}`,
  );
}

export function getEvent(eventId: string) {
  return call<Record<string, unknown>>(`/api/events/${encodeURIComponent(eventId)}`);
}

export function registerHandler(input: Record<string, unknown>) {
  return call<{ handlerId: string; enabled: boolean }>("/api/events/register", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function unregisterHandler(handlerId: string, ownerId: string) {
  return call<{ ok: boolean }>("/api/events/unregister", { method: "POST", body: JSON.stringify({ handlerId, ownerId }) });
}
