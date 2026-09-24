"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeEventStream } from "@/components/desktop/subscribeEventStream";
// Type-only, so the server-only transcript module never enters the client
// bundle — the entries themselves arrive over the read-only API below.
import type { TranscriptEntry } from "@/lib/agent/subagents/transcript";
import type { CostStatus } from "@/lib/self-heal/cost";
import { SELF_HEAL_EVENTS, type HealingCase, type SelfHealConfig } from "@/lib/self-heal/types";

// Client-side access to the Healing Case store (031-self-healing FR-022).
//
// Everything here is a read of the SERIALIZED case plus the four mutations the
// user is entitled to make (report / consent / answer / dismiss) — all real work
// stays server-side behind /api/self-heal (constitution II).
//
// Polling, not the 034 event stream, for the same reason the conflict pane
// polls: the pane must show progress the autonomous pipeline makes through its
// own steps, which produces no events between the escalation and the fix; and a
// plain re-query is exactly what restores the pane after a browser refresh.

const POLL_MS = 3_000;

/** An in-flight transcript is a file being appended to, so "live" is just a
 *  shorter re-read (FR-031). Bounded by maxSteps, and only while a case with a
 *  live run is open. */
const TRANSCRIPT_POLL_MS = 2_000;

/** The run-lifecycle events plus discard (scope-add FR-026/FR-036). They change
 *  a case's runs/stuck signature/status (or remove the row entirely), and the
 *  3s poll would show it eventually — but Stop and Discard are controls the
 *  user just pressed, so they should not feel like they might not have
 *  worked. */
const RUN_EVENT_TYPES: string[] = [
  SELF_HEAL_EVENTS.runStuck,
  SELF_HEAL_EVENTS.runAborted,
  SELF_HEAL_EVENTS.runRestarted,
  SELF_HEAL_EVENTS.caseDiscarded,
  // FR-038: a promote/discard just settled a preview-ready case — show the
  // resolved/dismissed chip now, not at the next poll tick.
  SELF_HEAL_EVENTS.fixPromoted,
  SELF_HEAL_EVENTS.fixDiscarded,
];

export interface SelfHealSnapshot {
  cases: HealingCase[];
  config: SelfHealConfig | null;
  cost: CostStatus | null;
  inFlightCaseId: string | null;
  slowQueue: string[];
  costQueue: string[];
}

const EMPTY: SelfHealSnapshot = {
  cases: [],
  config: null,
  cost: null,
  inFlightCaseId: null,
  slowQueue: [],
  costQueue: [],
};

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = (await res.json()) as T & { error?: { message?: string } };
  if (data?.error) throw new Error(data.error.message ?? "request failed");
  return data;
}

export function useSelfHealCases(): {
  snapshot: SelfHealSnapshot;
  error: string | null;
  loaded: boolean;
  refresh: () => Promise<void>;
} {
  const [snapshot, setSnapshot] = useState<SelfHealSnapshot>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const data = await json<SelfHealSnapshot>("/api/self-heal");
      if (alive.current) {
        setSnapshot({
          cases: data.cases ?? [],
          config: data.config ?? null,
          cost: data.cost ?? null,
          inFlightCaseId: data.inFlightCaseId ?? null,
          slowQueue: data.slowQueue ?? [],
          costQueue: data.costQueue ?? [],
        });
        setError(null);
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setLoaded(true);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- subscribing to an external system (the case store), same shape as useConflictSession
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    const unsubscribe = subscribeEventStream((msg) => {
      if (msg.kind === "new" && msg.eventType && RUN_EVENT_TYPES.includes(msg.eventType)) void refresh();
    });
    return () => {
      alive.current = false;
      clearInterval(timer);
      unsubscribe();
    };
  }, [refresh]);

  return { snapshot, error, loaded, refresh };
}

/** One case's full record plus its rendered diagnostics report. */
export function useSelfHealCase(caseId: string | undefined): {
  record: HealingCase | null;
  report: string;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [record, setRecord] = useState<HealingCase | null>(null);
  const [report, setReport] = useState("");
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    if (!caseId) {
      setRecord(null);
      setReport("");
      return;
    }
    try {
      const data = await json<{ case: HealingCase; report: string }>(
        `/api/self-heal?caseId=${encodeURIComponent(caseId)}`,
      );
      if (alive.current) {
        setRecord(data.case);
        setReport(data.report ?? "");
        setError(null);
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    }
  }, [caseId]);

  useEffect(() => {
    alive.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- subscribing to an external system (the case store)
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    // A run going stuck / being stopped / being restarted changes this case's
    // runs[], stuckSignature and status at once, so re-read the detail rather
    // than patching one field from the event payload.
    const unsubscribe = subscribeEventStream((msg) => {
      if (msg.kind === "new" && msg.eventType && RUN_EVENT_TYPES.includes(msg.eventType)) void refresh();
    });
    return () => {
      alive.current = false;
      clearInterval(timer);
      unsubscribe();
    };
  }, [refresh]);

  return { record, report, error, refresh };
}

export type { TranscriptEntry };

/**
 * One run's transcript, read through the read-only transcripts API (FR-030).
 *
 * The default (json) form answers with `entries` — the structured companion
 * (FR-037) the pane renders as a conversation. A pre-FR-037 run has no
 * companion; the API then falls back to the markdown document, so `entries` is
 * null and `transcript` carries the text.
 *
 * `found` is false — not an error — when the run has no transcript: it may have
 * run while `agentRuns.transcriptions.enabled` was off, which the pane renders
 * as an empty state rather than a failure.
 */
export function useRunTranscript(
  runId: string | undefined,
  live: boolean,
): { transcript: string; entries: TranscriptEntry[] | null; found: boolean; status: string; loading: boolean; error: string | null } {
  const [state, setState] = useState<{ transcript: string; entries: TranscriptEntry[] | null; found: boolean; status: string }>({
    transcript: "",
    entries: null,
    found: false,
    status: "",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    if (!runId) {
      setState({ transcript: "", entries: null, found: false, status: "" });
      return;
    }
    try {
      const data = await json<{ found?: boolean; markdown?: string; entries?: TranscriptEntry[]; status?: string }>(
        `/api/agent-transcripts?runId=${encodeURIComponent(runId)}`,
      );
      if (alive.current) {
        setState({
          transcript: data.markdown ?? "",
          entries: data.entries ?? null,
          found: data.found === true,
          status: data.status ?? "",
        });
        setError(null);
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    alive.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- subscribing to an external system (the transcript file on disk), same shape as the two hooks above
    setLoading(true);
    void refresh();
    // An ended run's file never changes again, so only a live one is polled.
    const timer = live ? setInterval(() => void refresh(), TRANSCRIPT_POLL_MS) : undefined;
    return () => {
      alive.current = false;
      if (timer) clearInterval(timer);
    };
  }, [refresh, live]);

  return { ...state, loading, error };
}

async function post(op: string, body: Record<string, unknown>): Promise<HealingCase | null> {
  const data = await json<{ case?: HealingCase }>(`/api/self-heal?op=${op}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return data.case ?? null;
}

/** C1's user-facing entry point for FR-001. */
export async function reportProblem(description: string, extra?: Record<string, unknown>): Promise<void> {
  await json("/api/self-heal?op=report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description, ...extra }),
  });
}

/** Approve (or reject) the case's recorded edit — FR-010/FR-011's consent gate.
 *  There is deliberately no diff in this payload: the edit applied is the one
 *  the Diagnostician already recorded on the case. */
export function consentToCase(caseId: string, approve: boolean): Promise<HealingCase | null> {
  return post("consent", { caseId, approve });
}

export function answerCase(caseId: string, answer: string): Promise<HealingCase | null> {
  return post("answer", { caseId, answer });
}

export function dismissSelfHealCase(caseId: string, reason?: string): Promise<HealingCase | null> {
  return post("dismiss", { caseId, ...(reason ? { reason } : {}) });
}

/** Stop the case's in-flight run (FR-034). The payload is only the case id —
 *  the run stopped is the one the CASE says is in flight, so this is not a
 *  "kill any run" call. */
export function stopCase(caseId: string): Promise<HealingCase | null> {
  return post("stop", { caseId });
}

/** Start a stopped case again, as a fresh run from the last committed
 *  artifact (FR-034). */
export function startCase(caseId: string): Promise<HealingCase | null> {
  return post("start", { caseId });
}

/** Delete the case outright (FR-036). Irreversible — the caller (RunActions)
 *  owns the confirm guard; transcripts survive, the record does not. */
export function discardCase(caseId: string): Promise<HealingCase | null> {
  return post("discard", { caseId });
}
