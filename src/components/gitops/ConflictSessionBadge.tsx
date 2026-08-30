"use client";

import { useEffect, useState } from "react";
import { GitMerge } from "lucide-react";
import { useOSStore } from "@/store/os-provider";
import type { ConflictSession, SessionStatus } from "@/lib/gitops/sessions/types";

// 035-spec-promote-conflict-escalation (FR-019) — ONE session-state indicator,
// shared by every surface that can trigger or observe a conflict
// (VersionControls, VersionsTab, ConflictResolutionDialog, GitRemotesTab).
//
// Each of those used to carry its own hand-written dead-end string ("escalated
// to DevOps Agent", "resolve manually, or force-push"). One component means
// they cannot drift, and every one of them gets the same live status, file
// count, rollback tag, and — the point — a button straight into the pane.

const LABEL: Record<SessionStatus, string> = {
  working: "agent resolving",
  "awaiting-user": "needs your decision",
  resolved: "resolved",
  failed: "resolution failed",
  "timed-out": "timed out",
  abandoned: "rolled back",
};

const TONE: Record<SessionStatus, string> = {
  working: "text-sky-300",
  "awaiting-user": "text-amber-300",
  resolved: "text-emerald-300",
  failed: "text-red-300",
  "timed-out": "text-red-300",
  abandoned: "text-white/50",
};

const POLL_MS = 3_000;

/** Poll one session by id. Returns null until it loads (or if it's gone). */
export function useConflictSessionSummary(sessionId: string | undefined): ConflictSession | null {
  const [session, setSession] = useState<ConflictSession | null>(null);
  useEffect(() => {
    if (!sessionId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSession(null);
      return;
    }
    let alive = true;
    const load = () => {
      fetch(`/api/gitops/sessions?id=${encodeURIComponent(sessionId)}`)
        .then((r) => r.json())
        .then((d: { session?: ConflictSession }) => {
          if (alive && d.session) setSession(d.session);
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [sessionId]);
  return session;
}

interface Props {
  sessionId: string | undefined;
  /** Conversation to fall back to when the session itself can't be read
   *  (e.g. an escalation from a BOS version that predates the session store). */
  conversationId?: string;
  /** `inline` for the cramped topbar; `block` for a settings panel. */
  variant?: "inline" | "block";
}

export function ConflictSessionBadge({ sessionId, conversationId, variant = "inline" }: Props) {
  const launch = useOSStore((s) => s.launch);
  const session = useConflictSessionSummary(sessionId);

  const open = () => {
    if (sessionId) launch("build-studio", { pane: "conflict", sessionId });
    else launch("chat");
  };

  if (!sessionId && !conversationId) return null;

  const status = session?.status;
  const unresolved = session ? session.files.filter((f) => f.resolvedContent === undefined).length : undefined;
  const tone = status ? TONE[status] : "text-amber-300";
  const label = status ? LABEL[status] : "handed to the conflict agent";

  const button = (
    <button
      data-testid="conflict-open-resolution"
      onClick={open}
      title={
        sessionId
          ? "Open the Build Studio conflict-resolution pane for this session"
          : "Open the Assistant — the conflict conversation is in the list"
      }
      className="inline-flex items-center gap-1 rounded bg-amber-500/25 px-1.5 py-0.5 text-[11px] hover:bg-amber-500/40"
    >
      <GitMerge size={11} />
      {sessionId ? "Open resolution" : "Open Assistant"}
    </button>
  );

  if (variant === "inline") {
    return (
      <span data-testid="conflict-session-badge" data-status={status ?? "unknown"} className={`flex items-center gap-1.5 ${tone}`}>
        conflict — {label}
        {typeof unresolved === "number" && unresolved > 0 && (
          <span className="text-white/45">
            ({unresolved} file{unresolved === 1 ? "" : "s"})
          </span>
        )}
        {button}
      </span>
    );
  }

  return (
    <div
      data-testid="conflict-session-badge"
      data-status={status ?? "unknown"}
      className="rounded border border-amber-400/30 bg-amber-500/10 p-2.5 text-[11px]"
    >
      <div className={`flex items-center gap-2 font-medium ${tone}`}>
        <GitMerge size={12} />
        Conflict — {label}
        <span className="ml-auto">{button}</span>
      </div>
      {session && (
        <>
          <div className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-white/50">
            <span>repo</span>
            <code className="text-white/75">{session.workContext.label}</code>
            <span>branch</span>
            <code className="text-white/75">{session.featureBranch}</code>
            <span>rollback tag</span>
            <code className="text-white/75">{session.rollbackTag}</code>
          </div>
          {session.files.length > 0 && (
            <div className="mt-1.5">
              <p className="mb-1 text-white/45">Conflicting files ({session.files.length}):</p>
              <div className="max-h-24 overflow-y-auto rounded bg-black/30 p-1.5 font-mono text-[10.5px]">
                {session.files.map((f) => (
                  <div key={f.path} className={f.resolvedContent !== undefined ? "text-emerald-300/70" : "text-white/60"}>
                    {f.resolvedContent !== undefined ? "✓ " : "• "}
                    {f.path}
                  </div>
                ))}
              </div>
            </div>
          )}
          {session.result?.error && <p className="mt-1.5 text-red-300/80">{session.result.error}</p>}
        </>
      )}
    </div>
  );
}
