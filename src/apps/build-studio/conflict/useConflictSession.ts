"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ConflictHunk, ConflictMarker, ConflictSession } from "@/lib/gitops/sessions/types";

// Client-side access to the conflict-resolution session. Everything here is a
// read of the SERIALIZED session plus the one mutation the client is allowed
// to make (answer a decision / abandon) — all git work stays server-side
// behind /api/gitops/sessions (constitution II).

const POLL_MS = 2_000;

export interface ThreeWayFile {
  path: string;
  binary: boolean;
  conflict: ConflictMarker;
  base: string | null;
  ours: string | null;
  theirs: string | null;
  markers: string | null;
  hunks: ConflictHunk[];
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = (await res.json()) as T & { error?: { message?: string } };
  if (data?.error) throw new Error(data.error.message ?? "request failed");
  return data;
}

/** Poll one session. Polling (rather than the event stream) because the pane
 *  must show per-file progress the agent makes through its tools, which
 *  produces no events — and because a plain re-query is exactly what restores
 *  the pane after a browser refresh (FR-024). */
export function useConflictSession(sessionId: string | undefined) {
  const [session, setSession] = useState<ConflictSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setSession(null);
      setLoaded(true);
      return;
    }
    try {
      const data = await json<{ session: ConflictSession }>(`/api/gitops/sessions?id=${encodeURIComponent(sessionId)}`);
      if (alive.current) {
        setSession(data.session);
        setError(null);
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setLoaded(true);
    }
  }, [sessionId]);

  useEffect(() => {
    alive.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- subscribing to an external system (the session store), same shape as EventBell's stream subscription
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  return { session, error, loaded, refresh };
}

/** The three-way content of ONE file, derived server-side from the session's
 *  refs (never from merge-index stages, which no longer exist by then). */
export function useThreeWay(sessionId: string | undefined, path: string | undefined) {
  const [file, setFile] = useState<ThreeWayFile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId || !path) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing the fetched value when its inputs go away, not a cascading update
      setFile(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    void json<{ file: ThreeWayFile }>(
      `/api/gitops/sessions?id=${encodeURIComponent(sessionId)}&file=${encodeURIComponent(path)}`,
    )
      .then((data) => {
        if (alive) setFile(data.file);
      })
      .catch((e: Error) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [sessionId, path]);

  return { file, loading, error };
}

/** Answer the agent's open decision. The pane's per-hunk buttons and the
 *  chat's decision card are the same code path (design §5.2): this PATCH
 *  records the answer, flips the session back to `working`, and re-launches
 *  the agent on a fresh run over the same conversation. */
export async function answerConflictDecision(
  sessionId: string,
  body: { decisionId?: string; optionId: string; manualText?: string },
): Promise<ConflictSession> {
  const data = await json<{ session: ConflictSession }>(`/api/gitops/sessions?id=${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "answer", ...body }),
  });
  return data.session;
}

export async function abandonConflictSession(sessionId: string): Promise<ConflictSession> {
  const data = await json<{ session: ConflictSession }>(`/api/gitops/sessions?id=${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "abandon" }),
  });
  return data.session;
}

/** The newest non-terminal session, if any. Drives the browser-refresh
 *  restore: the pane re-derives what is active from the durable store, with
 *  no event re-emit involved (FR-024). */
export async function findActiveConflictSession(): Promise<ConflictSession | null> {
  try {
    const data = await json<{ sessions: ConflictSession[] }>("/api/gitops/sessions");
    return data.sessions[0] ?? null;
  } catch {
    return null;
  }
}
