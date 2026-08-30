"use client";

import { useCallback, useEffect, useState } from "react";
import { GitMerge, Loader2 } from "lucide-react";
import type { ConflictSession } from "@/lib/gitops/sessions/types";
import { ConflictStatusHeader } from "./ConflictStatusHeader";
import { ConflictFileList } from "./ConflictFileList";
import { ConflictFileView } from "./ConflictFileView";
import type { DecisionOptionId } from "./ConflictDecisionCard";
import { abandonConflictSession, answerConflictDecision, useConflictSession } from "./useConflictSession";

// 035-spec-promote-conflict-escalation — the conflict-resolution pane (D1/D5).
//
// It REPLACES Build Studio's centre artifact-viewer column while a session is
// active; the left spec tree stays for context, and the RIGHT column is Build
// Studio's EXISTING chat, re-pointed at the session's conversation — the
// agent↔user channel is that chat, not a second mechanism (FR-007a).
//
// Layout and interactions follow mockup.html, which is the binding UI contract
// for this pane (D8).

interface Props {
  sessionId: string;
  /** Called with the session once it goes terminal, so the host can revert
   *  the centre column back to the artifact viewer. */
  onSettled?: (session: ConflictSession) => void;
}

export function ConflictPane({ sessionId, onSettled }: Props) {
  const { session, error, loaded, refresh } = useConflictSession(sessionId);
  const [selected, setSelected] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [confirmAbandon, setConfirmAbandon] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Follow the agent: whatever it is parked on becomes the selected file, so
  // the user lands on the thing that actually needs them.
  useEffect(() => {
    if (!session) return;
    const pending = session.pendingDecision?.path;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelected((cur) => pending ?? cur ?? session.files[0]?.path);
  }, [session]);

  useEffect(() => {
    if (session && ["resolved", "failed", "timed-out", "abandoned"].includes(session.status)) {
      onSettled?.(session);
    }
  }, [session, onSettled]);

  const answer = useCallback(
    async (optionId: DecisionOptionId, manualText?: string) => {
      if (!session?.pendingDecision) return;
      setBusy(true);
      try {
        await answerConflictDecision(session.id, {
          decisionId: session.pendingDecision.id,
          optionId,
          manualText,
        });
        setToast(`Applied "${optionId}" — the agent is continuing.`);
      } catch (e) {
        setToast(`Could not record the decision: ${(e as Error).message}`);
      } finally {
        setBusy(false);
        await refresh();
        setTimeout(() => setToast(null), 3200);
      }
    },
    [session, refresh],
  );

  const abandon = useCallback(async () => {
    if (!session) return;
    setConfirmAbandon(false);
    setBusy(true);
    try {
      await abandonConflictSession(session.id);
      setToast("Rolled back — the pre-reconciliation state is restored.");
    } catch (e) {
      setToast(`Roll back failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      await refresh();
      setTimeout(() => setToast(null), 3200);
    }
  }, [session, refresh]);

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[12px] text-white/40">
        <Loader2 size={14} className="animate-spin" /> Loading the conflict session…
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[12px] text-white/40">
        <GitMerge size={20} className="text-white/25" />
        <p>No conflict session {sessionId ? <code className="text-white/60">{sessionId}</code> : null} was found.</p>
        {error && <p className="text-red-300/80">{error}</p>}
      </div>
    );
  }

  return (
    <div data-testid="conflict-pane" data-session-id={session.id} className="relative flex h-full min-w-0 flex-col">
      <ConflictStatusHeader
        session={session}
        selected={selected}
        onSelect={setSelected}
        onAbandon={() => setConfirmAbandon(true)}
        busy={busy}
      />

      <div className="flex min-h-0 flex-1">
        <ConflictFileList session={session} selected={selected} onSelect={setSelected} />
        <ConflictFileView session={session} path={selected} busy={busy} onAnswer={answer} />
      </div>

      {confirmAbandon && (
        <div className="absolute inset-0 z-50 grid place-items-center bg-black/60">
          <div className="w-[420px] max-w-[90%] overflow-hidden rounded-xl border border-white/15 bg-neutral-900 shadow-2xl">
            <div className="border-b border-white/10 px-4 py-3 text-[13px] font-bold text-red-300">
              Abandon resolution &amp; roll back?
            </div>
            <div className="px-4 py-3.5 text-[12px] leading-relaxed text-white/75">
              This restores the <b>{session.workContext.label}</b> repo to the state before reconciliation, using
              rollback tag <code className="rounded bg-white/10 px-1.5">{session.rollbackTag}</code>.
              <br />
              <br />
              The in-progress resolution is discarded. <code className="rounded bg-white/10 px-1.5">
                {session.baseBranch}
              </code>{" "}
              is never left in a conflicted state. This is safe to do at any point.
            </div>
            <div className="flex justify-end gap-2 border-t border-white/10 px-4 py-3">
              <button
                onClick={() => setConfirmAbandon(false)}
                className="rounded-md border border-white/15 px-3 py-1.5 text-[12px] text-white/60 hover:bg-white/[0.06]"
              >
                Cancel
              </button>
              <button
                data-testid="conflict-abandon-confirm"
                onClick={() => void abandon()}
                className="rounded-md border border-red-500 bg-red-500 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-red-400"
              >
                Roll back
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div
          data-testid="conflict-toast"
          className="pointer-events-none absolute bottom-5 left-1/2 -translate-x-1/2 rounded-lg border border-emerald-400/40 bg-neutral-900 px-4 py-2 text-[12px] text-emerald-300 shadow-2xl"
        >
          {toast}
        </div>
      )}
    </div>
  );
}
