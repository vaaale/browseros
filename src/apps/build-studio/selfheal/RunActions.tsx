"use client";

import { useState } from "react";
import type { HealingCase } from "@/lib/self-heal/types";
import { discardCase, startCase, stopCase } from "./useSelfHealCases";

// The per-row Run cell for the case list (031-self-healing scope-add,
// FR-033/FR-034/FR-036, mockup.html §1's Run column).
//
// This lives in the LIST, not the detail view, because Stop/Start/Discard are
// triage controls: the moment the user needs them is while scanning the table
// for the run that is misbehaving, not after opening a case. One compact
// inline cluster per row — stuck indicator, then whichever of Stop/Start the
// status allows (never both), then Discard, which is available on EVERY row.
//
// Stop is AMBER (recoverable — `stopped` is a pause, Start brings it back);
// Discard is a muted red ✕ because it is the one irreversible control here,
// hence also the confirm guard.

const BTN =
  "inline-flex items-center gap-1 rounded-[5px] border px-2 py-[3px] text-[10px] font-semibold transition-colors disabled:opacity-40";

export function RunActions({ record, onChanged }: { record: HealingCase; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inFlight = record.status === "diagnosing" || record.status === "bs-pipeline";
  const stopped = record.status === "stopped" || record.status === "failed";
  const stuck = record.stuckSignature;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span
      className="inline-flex items-center justify-end gap-1.5 whitespace-nowrap"
      data-testid={`self-heal-run-actions-${record.id}`}
      // The row itself is a click target that opens the case; none of these
      // controls should ALSO navigate (a confirmed Discard would land the user
      // on a case that no longer exists).
      onClick={(e) => e.stopPropagation()}
    >
      {error ? (
        <span className="text-[10px] font-bold text-red-400" title={error} data-testid="self-heal-run-actions-error">
          !
        </span>
      ) : null}

      {stuck ? (
        <span
          className="text-[11px] text-amber-300"
          data-testid="self-heal-stuck-indicator"
          title={
            stuck.reason === "max-steps"
              ? "Stuck — the run used its whole step budget with no progress"
              : `Stuck — repeated ${stuck.tool} ×${stuck.count} with no progress`
          }
        >
          ⚠
        </span>
      ) : null}

      {inFlight ? (
        <button
          type="button"
          data-testid="self-heal-stop-run"
          disabled={busy}
          onClick={() => void run(() => stopCase(record.id))}
          title="Stop this run (recoverable — Start relaunches from the last committed artifact)"
          className={`${BTN} border-amber-400/40 bg-amber-400/15 text-amber-100 hover:bg-amber-400/25`}
        >
          ⏹ Stop
        </button>
      ) : stopped ? (
        <button
          type="button"
          data-testid="self-heal-start-run"
          disabled={busy}
          onClick={() => void run(() => startCase(record.id))}
          title="Start a fresh run from the last committed artifact"
          className={`${BTN} border-emerald-400/40 bg-emerald-400/15 text-emerald-100 hover:bg-emerald-400/25`}
        >
          ▶ Start
        </button>
      ) : (
        <span className="text-[10px] text-white/25" aria-hidden>
          —
        </span>
      )}

      <button
        type="button"
        data-testid="self-heal-discard-case"
        disabled={busy}
        onClick={() => {
          if (!window.confirm("Discard this case? This cannot be undone.")) return;
          void run(() => discardCase(record.id));
        }}
        title="Discard this case (irreversible)"
        className={`${BTN} border-red-400/25 bg-red-400/[0.08] text-red-300/80 hover:bg-red-400/20 hover:text-red-200`}
      >
        ✕
      </button>
    </span>
  );
}
