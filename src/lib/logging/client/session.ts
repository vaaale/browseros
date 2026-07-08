"use client";

// The browser session id: stable for this browser/window session — opening BOS in a
// new browser (or a new tab session) yields a NEW id. It partitions logs and
// correlates frontend ↔ backend ↔ supervisor records (specs/017-central-logging).

const KEY = "bos.sessionId";
let cached: string | null = null;

export function getSessionId(): string {
  if (cached) return cached;
  if (typeof window === "undefined") return "";
  try {
    let id = window.sessionStorage.getItem(KEY);
    if (!id) {
      id =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      window.sessionStorage.setItem(KEY, id);
    }
    cached = id;
    return id;
  } catch {
    // Private mode / storage blocked: fall back to an in-memory id for this load.
    cached = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    return cached;
  }
}

/** Header to attach the session id to any /api/* or /__supervisor/* request. */
export function sessionHeader(): Record<string, string> {
  const id = getSessionId();
  return id ? { "x-bos-session": id } : {};
}
