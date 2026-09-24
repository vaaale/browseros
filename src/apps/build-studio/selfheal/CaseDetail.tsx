"use client";

import { useCallback, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { humanCaseId, type HealingCase } from "@/lib/self-heal/types";
import { ScopeClassBadge } from "./ScopeClassBadge";
import { StatusCell } from "./CaseList";
import { ConsentCard } from "./ConsentCard";
import { SuspendedCard } from "./SuspendedCard";
import { PreviewStatus } from "./PreviewStatus";
import { TranscriptsSection } from "./TranscriptsSection";
import { answerCase, consentToCase, dismissSelfHealCase, useSelfHealCase } from "./useSelfHealCases";

// The case detail view (031-self-healing FR-022b–e, mockup.html §2).
//
// Three parts, in this order: a header strip (scope class, ownership, proposed
// surface, status), the ACTION AREA — which card appears is keyed off the case's
// state, not its scope class alone, because a suspended class-e case needs the
// question and not the build status — and then the diagnostics report plus the
// state-transition timeline as the evidence behind whatever the action asks for.
//
// The scope-add adds one section here (FR-022f): Transcripts, below the
// timeline, as the evidence for what the run has actually been doing. The run
// CONTROLS (stuck indicator, Stop/Start, Discard) deliberately live in the case
// LIST's Run column instead (RunActions.tsx) — triage happens while scanning
// the table, not after opening a case.

const CARD = "rounded-lg border border-white/10 bg-white/[0.03] p-3";

function ActionArea({ record, onChanged }: { record: HealingCase; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
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
    },
    [onChanged],
  );

  // Suspended wins over everything: it is the only state that blocks the
  // pipeline, so the question is what the user is here for.
  const card =
    record.status === "suspended" ? (
      <SuspendedCard record={record} busy={busy} onSubmit={(answer) => void run(() => answerCase(record.id, answer))} />
    ) : record.status === "awaiting-consent" ? (
      <ConsentCard
        record={record}
        busy={busy}
        onApprove={() => void run(() => consentToCase(record.id, true))}
        onDismiss={() => void run(() => dismissSelfHealCase(record.id, "dismissed from the Self-Heal page"))}
      />
    ) : record.status === "bs-pipeline" || record.status === "preview-ready" || record.status === "failed" ? (
      <PreviewStatus record={record} />
    ) : record.status === "env-only" ? (
      <div className={CARD} data-testid="self-heal-env-card">
        <div className="mb-1.5 flex items-center gap-2">
          <ScopeClassBadge scopeClass="a" />
          <span className="text-xs font-semibold text-white">No durable change</span>
        </div>
        <p className="text-[11px] leading-snug text-white/60">
          This was an external/transient failure, so nothing was changed. Retry the original action once the
          environment recovers.
        </p>
      </div>
    ) : record.status === "notified" ? (
      <div className={CARD} data-testid="self-heal-notify-card">
        <div className="mb-1.5 flex items-center gap-2">
          <ScopeClassBadge scopeClass="d" />
          <span className="text-xs font-semibold text-white">Notification only</span>
        </div>
        <p className="text-[11px] leading-snug text-white/60">
          The bug looks like it is in <code className="font-mono text-[10px] text-amber-200">{record.appId ?? "a marketplace app"}</code>, which
          you do not maintain — there is no copy of it in your own <code className="font-mono text-[10px]">user-apps</code> marketplace, so
          BrowserOS will not modify it. Report it upstream, or clone the item into your marketplace and re-report to
          have it fixed here.
        </p>
      </div>
    ) : record.status === "stopped" ? (
      <div className={CARD} data-testid="self-heal-stopped-card">
        <div className="mb-1.5 text-xs font-semibold text-white">Stopped</div>
        <p className="text-[11px] leading-snug text-white/60">
          You stopped this case&apos;s run (or it used up its whole step budget). Nothing is running and nothing is
          lost — read the transcript below to see where it got to, then use Start in the case list&apos;s Run column to
          run it again from the last committed artifact, or dismiss the case.
        </p>
      </div>
    ) : record.status === "queued-cost" || record.status === "queued-slow" ? (
      <div className={CARD} data-testid="self-heal-queued-card">
        <div className="mb-1.5 text-xs font-semibold text-white">Queued</div>
        <p className="text-[11px] leading-snug text-white/60">
          {record.status === "queued-cost"
            ? "Today's self-heal token budget is spent. This case is queued and will be diagnosed after the next UTC midnight — it was not dropped."
            : "Another fix is running. Only one runs at a time, so this one starts as soon as that one reaches a conclusion."}
        </p>
      </div>
    ) : null;

  if (!card && !error) return null;
  return (
    <div className="flex flex-col gap-2">
      {card}
      {error ? (
        <p className="rounded-md border border-red-400/25 bg-red-400/10 px-2.5 py-1.5 text-[11px] text-red-200" data-testid="self-heal-action-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Timeline({ record }: { record: HealingCase }) {
  return (
    <ol className="flex flex-col gap-1.5" data-testid="self-heal-timeline">
      {record.timeline.map((entry, i) => (
        <li key={`${entry.at}-${i}`} className="flex gap-2.5 text-[11px]">
          <span className="w-36 shrink-0 font-mono text-[10px] text-white/35">
            {new Date(entry.at).toLocaleString()}
          </span>
          <span className="w-32 shrink-0 font-semibold text-white/70">{entry.status}</span>
          <span className="min-w-0 flex-1 text-white/50">{entry.note ?? ""}</span>
        </li>
      ))}
    </ol>
  );
}

export function CaseDetail({ caseId, onBack }: { caseId: string; onBack: () => void }) {
  const { record, report, error, refresh } = useSelfHealCase(caseId);

  if (error) {
    return (
      <div className="p-3">
        <button onClick={onBack} className="mb-2 inline-flex items-center gap-1 text-[11px] text-white/50 hover:text-white/80">
          <ArrowLeft className="h-3 w-3" aria-hidden /> Back to cases
        </button>
        <p className="text-xs text-red-400">{error}</p>
      </div>
    );
  }
  if (!record) return <p className="p-3 text-xs text-white/40">Loading case…</p>;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3" data-testid={`self-heal-detail-${record.id}`}>
      <button onClick={onBack} className="inline-flex w-fit items-center gap-1 text-[11px] text-white/50 hover:text-white/80">
        <ArrowLeft className="h-3 w-3" aria-hidden /> Back to cases
      </button>

      <div className={CARD}>
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-white">{humanCaseId(record.id)}</span>
          <StatusCell status={record.status} />
          <ScopeClassBadge scopeClass={record.scopeClass} />
          <span className="text-[10px] text-white/35">{record.trigger} trigger</span>
        </div>
        <p className="text-[11px] leading-snug text-white/70">{record.title}</p>
        {record.proposedSurface ? (
          <p className="mt-1.5 text-[11px] text-white/50">
            Proposed surface:{" "}
            <code className="rounded bg-white/5 px-1 py-0.5 font-mono text-[10px] text-white/80">{record.proposedSurface}</code>
          </p>
        ) : null}
        {record.verdict ? <p className="mt-1 text-[11px] text-white/50">Verdict: {record.verdict}</p> : null}
      </div>

      <ActionArea record={record} onChanged={() => void refresh()} />

      <div className={CARD}>
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-violet-300">Diagnostics report</div>
        {report ? (
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-white/75">{report}</pre>
        ) : (
          <p className="text-[11px] text-white/40">
            No report yet — the Diagnostician writes it to{" "}
            <code className="font-mono text-[10px]">/Documents/BOS Improvements/</code> when it finishes investigating.
          </p>
        )}
      </div>

      <div className={CARD}>
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-violet-300">Timeline</div>
        <Timeline record={record} />
      </div>

      <TranscriptsSection record={record} />
    </div>
  );
}
