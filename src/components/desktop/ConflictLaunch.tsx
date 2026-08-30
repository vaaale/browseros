"use client";

import { useEffect, useRef } from "react";
import { useOSStore } from "@/store/os-provider";
import { subscribeEventStream } from "./subscribeEventStream";
import { CONFLICT_ESCALATED_EVENT } from "@/lib/gitops/sessions/types";

// 035-spec-promote-conflict-escalation (FR-007) — the AUTO-launch.
//
// 034's UI handlers are click-resolved: the Event Viewer turns a clicked event
// into a `launch`. A conflict must not wait for a click — the user has to be
// taken to it. This is the one component that does that, and it is
// deliberately scoped to the ONE event type: a general "every UI event
// auto-launches its app" rule would be a very different (and much worse)
// product (ADR-3).
//
// A sibling of EventBell, mounted in the topbar, because that is already where
// the NDJSON event stream is subscribed browser-side.
//
// The stream frame carries only the event id and type (StreamEvent), so the
// session id is fetched from the event record. `launch` on the singleton BS
// window focuses it and merges `params`, which makes a repeat launch (the boot
// re-emit's benign double-fire, design S2) idempotent — no dedup needed.
export function ConflictLaunch() {
  const launch = useOSStore((s) => s.launch);
  // Refs, not state: this component renders nothing and must never re-render
  // the topbar just because a conflict came in.
  const launchRef = useRef(launch);
  useEffect(() => {
    launchRef.current = launch;
  }, [launch]);
  const seen = useRef(new Set<string>());

  useEffect(() => {
    // The stream replays from the beginning of history. Auto-launch is about
    // "a conflict just happened while you were here" — replaying every
    // conflict this instance has EVER escalated would yank the user into an
    // old, long-settled session every time they open a tab. Anything that
    // happened before this subscriber existed is the pane's own
    // restore-on-open query's job (FR-024), not this one's.
    const mountedAt = Date.now();

    const openFor = async (eventId: string) => {
      try {
        const res = await fetch(`/api/events/${encodeURIComponent(eventId)}`);
        const data = (await res.json()) as { payload?: { sessionId?: string } };
        const sessionId = data?.payload?.sessionId;
        if (!sessionId || seen.current.has(sessionId)) return;
        seen.current.add(sessionId);
        launchRef.current("build-studio", { pane: "conflict", sessionId });
      } catch {
        // Couldn't read the event — the pane still recovers on its own, by
        // querying the session store the next time Build Studio opens.
      }
    };

    // FR-024 — the restore half. A browser refresh (or a first tab opened
    // after a BOS restart) replays no events the user should be re-launched
    // for, and open windows don't survive a reload, so the pane would simply
    // be gone while the conflict is still very much live. Ask the durable
    // store instead: if a session is still non-terminal, put the user back in
    // front of it. This is a query, not an event replay — which is exactly
    // why FR-024 says no re-emit is needed for the refresh case.
    void (async () => {
      try {
        const res = await fetch("/api/gitops/sessions");
        const data = (await res.json()) as { sessions?: { id: string }[] };
        const active = data?.sessions?.[0];
        if (!active || seen.current.has(active.id)) return;
        seen.current.add(active.id);
        launchRef.current("build-studio", { pane: "conflict", sessionId: active.id });
      } catch {
        // No session store reachable — nothing to restore.
      }
    })();

    const unsubscribe = subscribeEventStream((msg) => {
      if (msg.kind !== "new") return;
      if (msg.eventType !== CONFLICT_ESCALATED_EVENT) return;
      if (!msg.eventId) return;
      if (typeof msg.ts === "number" && msg.ts < mountedAt) return; // replayed history
      void openFor(msg.eventId);
    });
    return unsubscribe;
  }, []);

  return null;
}
