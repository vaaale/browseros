"use client";

import { Loader2 } from "lucide-react";
import { humanCaseId, type CaseStatus, type HealingCase } from "@/lib/self-heal/types";
import { ScopeClassBadge } from "./ScopeClassBadge";
import { RunActions } from "./RunActions";

// The case list (031-self-healing FR-022a; column order is binding per
// mockup.html §1: Status → Case → Trigger → Scope Class → Run).
//
// The Run column (scope-add FR-033/034/036) is per-row triage: the stuck
// indicator, Stop/Start and Discard live HERE, not in the detail view — the
// user scanning for the misbehaving run should not have to open a case to act
// on it.
//
// Age is deliberately NOT a column: it is derivable from the timeline's first
// entry and the mockup omits it. Sorting puts everything that wants the user's
// attention first — a suspended question, then a running pipeline, then
// anything awaiting consent — because that is the order in which the list is
// actually useful.

const STATUS_TONE: Record<CaseStatus, string> = {
  new: "text-white/60",
  "queued-cost": "text-white/40",
  diagnosing: "text-blue-300",
  diagnosed: "text-blue-300",
  "env-only": "text-white/35",
  "awaiting-consent": "text-violet-300",
  applied: "text-emerald-300",
  notified: "text-amber-300",
  "queued-slow": "text-white/45",
  "bs-pipeline": "text-violet-300",
  suspended: "text-amber-300",
  // Muted amber-grey, deliberately distinct from amber `suspended` (waiting on
  // YOU, holding the pipeline) and red `failed` (over, no retry): `stopped`
  // means paused by you and recoverable.
  stopped: "text-[#c4a56a]",
  "preview-ready": "text-emerald-300",
  // Green, deliberately distinct from amber `suspended`, red `failed` and the
  // neutral greys: the fix was promoted and the case is done (FR-038).
  resolved: "text-emerald-400",
  dismissed: "text-white/35",
  failed: "text-red-400",
  abandoned: "text-white/35",
};

const SPINNING: CaseStatus[] = ["diagnosing", "bs-pipeline"];

/** Attention first, then newest. */
const PRIORITY: Record<CaseStatus, number> = {
  suspended: 0,
  "bs-pipeline": 1,
  // A stopped case is waiting on a human decision (Start or dismiss) just as
  // much as a consent request is, so it sorts with them rather than down with
  // the finished cases.
  stopped: 2,
  "awaiting-consent": 3,
  diagnosing: 4,
  diagnosed: 5,
  new: 6,
  "queued-slow": 7,
  "queued-cost": 8,
  "preview-ready": 9,
  failed: 10,
  notified: 11,
  applied: 12,
  // Done and needing nothing — sorts with the other finished cases.
  resolved: 13,
  "env-only": 14,
  dismissed: 15,
  abandoned: 16,
};

export function sortCases(cases: HealingCase[]): HealingCase[] {
  return [...cases].sort((a, b) => {
    const p = (PRIORITY[a.status] ?? 99) - (PRIORITY[b.status] ?? 99);
    return p !== 0 ? p : b.createdAt - a.createdAt;
  });
}

export function StatusCell({ status }: { status: CaseStatus }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${STATUS_TONE[status] ?? "text-white/60"}`}>
      {SPINNING.includes(status) ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
      {status}
    </span>
  );
}

export function CaseList({
  cases,
  selectedId,
  onSelect,
  onChanged,
}: {
  cases: HealingCase[];
  selectedId?: string;
  onSelect: (caseId: string) => void;
  /** Refetch after a Run-column mutation (stop/start/discard). */
  onChanged: () => void;
}) {
  if (cases.length === 0) {
    return (
      <p className="px-1 py-6 text-xs text-white/40" data-testid="self-heal-empty">
        No healing cases yet. Report a problem above, or turn on the automatic triggers in Settings → Self Improvement
        and BrowserOS will open cases on its own.
      </p>
    );
  }
  return (
    <table className="w-full border-collapse text-left" data-testid="self-heal-case-list">
      <thead>
        <tr className="border-b border-white/10 text-[10px] uppercase tracking-wide text-white/35">
          <th className="py-1.5 pr-3 font-semibold">Status</th>
          <th className="py-1.5 pr-3 font-semibold">Case</th>
          <th className="py-1.5 pr-3 font-semibold">Trigger</th>
          <th className="py-1.5 pr-3 font-semibold">Scope Class</th>
          <th className="py-1.5 text-right font-semibold">Run</th>
        </tr>
      </thead>
      <tbody>
        {cases.map((record) => (
          <tr
            key={record.id}
            data-testid={`self-heal-row-${record.id}`}
            onClick={() => onSelect(record.id)}
            className={`cursor-pointer border-b border-white/5 align-top transition-colors ${
              selectedId === record.id ? "bg-white/10" : "hover:bg-white/5"
            }`}
          >
            <td className="py-2 pr-3 whitespace-nowrap">
              <StatusCell status={record.status} />
            </td>
            <td className="py-2 pr-3">
              <div className="text-[11px] font-semibold text-white">{humanCaseId(record.id)}</div>
              <div className="max-w-[42ch] truncate text-[10px] text-white/50">{record.title}</div>
            </td>
            <td className="py-2 pr-3 text-[11px] whitespace-nowrap text-white/60">{record.trigger}</td>
            <td className="py-2 pr-3">
              <ScopeClassBadge scopeClass={record.scopeClass} />
            </td>
            <td className="py-2 text-right">
              <RunActions record={record} onChanged={onChanged} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
