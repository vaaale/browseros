"use client";

import { useCallback, useEffect, useState } from "react";
import { HeartPulse, Plus, RefreshCw } from "lucide-react";
import { CaseList, sortCases } from "./CaseList";
import { CaseDetail } from "./CaseDetail";
import { ScopeClassLegend } from "./ScopeClassBadge";
import { reportProblem, useSelfHealCases } from "./useSelfHealCases";

// The Build Studio Self-Heal pane (031-self-healing FR-022).
//
// It OWNS Build Studio's centre column while selected — a peer of the conflict
// pane, same shape: the left spec tree stays for context, the right column
// stays the Build Studio chat. Everything here reads the durable case store
// through /api/self-heal, so a browser refresh restores the exact same view
// with no event replay involved.

const BTN = "rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors disabled:opacity-40";
const BTN_PRIMARY = `${BTN} border border-violet-500/40 bg-violet-500/20 text-violet-200 hover:bg-violet-500/30`;
const BTN_GHOST = `${BTN} border border-white/15 bg-white/5 text-white/70 hover:bg-white/10`;

function ReportForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [description, setDescription] = useState("");
  const [toolName, setToolName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await reportProblem(description.trim(), toolName.trim() ? { toolName: toolName.trim() } : undefined);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [description, toolName, onDone]);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-white/10 bg-white/[0.03] p-3" data-testid="self-heal-report-form">
      <div className="text-xs font-semibold text-white">Report a problem</div>
      <p className="text-[10px] leading-snug text-white/45">
        Say what you tried, what you expected, and what happened instead. A Diagnostician reads BrowserOS&apos;s own
        source to work out whether this is a real gap or a usage error — specifics beat adjectives.
      </p>
      <textarea
        data-testid="self-heal-report-description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={4}
        spellCheck={false}
        placeholder="e.g. the agent couldn't open the portfolio report in the Editor because bos_app_launch doesn't accept a file parameter"
        className="w-full resize-y rounded-md border border-white/15 bg-black/40 px-2.5 py-2 text-[11px] text-white/85 outline-none focus:border-white/30"
      />
      <input
        data-testid="self-heal-report-tool"
        value={toolName}
        onChange={(e) => setToolName(e.target.value)}
        placeholder="Tool or subsystem involved (optional)"
        className="w-full rounded-md border border-white/15 bg-black/40 px-2.5 py-1.5 text-[11px] text-white/85 outline-none focus:border-white/30"
      />
      {error ? <p className="text-[11px] text-red-400">{error}</p> : null}
      <div className="flex items-center gap-2">
        <button className={BTN_PRIMARY} data-testid="self-heal-report-submit" disabled={busy || !description.trim()} onClick={() => void submit()}>
          Report
        </button>
        <button className={BTN_GHOST} disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function SelfHealPane({ initialCaseId }: { initialCaseId?: string }) {
  const { snapshot, error, loaded, refresh } = useSelfHealCases();
  const [selectedId, setSelectedId] = useState<string>(initialCaseId ?? "");
  const [reporting, setReporting] = useState(false);

  useEffect(() => {
    if (initialCaseId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- following an external deep-link param, same shape as the conflict pane's sessionIdParam effect
      setSelectedId(initialCaseId);
    }
  }, [initialCaseId]);

  if (selectedId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <CaseDetail caseId={selectedId} onBack={() => setSelectedId("")} />
      </div>
    );
  }

  const cases = sortCases(snapshot.cases);
  const cfg = snapshot.config;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="self-heal-pane">
      <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-2">
        <HeartPulse className="h-4 w-4 text-violet-300" aria-hidden />
        <span className="text-xs font-semibold text-white">Self-Heal</span>
        {cfg && !cfg.enabled ? (
          <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
            disabled in Settings
          </span>
        ) : null}
        <div className="flex-1" />
        <button className={BTN_GHOST} onClick={() => void refresh()} title="Refresh">
          <RefreshCw className="h-3 w-3" aria-hidden />
        </button>
        <button className={BTN_PRIMARY} data-testid="self-heal-report-open" onClick={() => setReporting((v) => !v)}>
          <span className="inline-flex items-center gap-1">
            <Plus className="h-3 w-3" aria-hidden /> Report a problem
          </span>
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {reporting ? (
          <ReportForm
            onDone={() => {
              setReporting(false);
              void refresh();
            }}
            onCancel={() => setReporting(false)}
          />
        ) : null}

        {error ? <p className="text-xs text-red-400">{error}</p> : null}
        {!loaded ? (
          <p className="text-xs text-white/40">Loading cases…</p>
        ) : (
          <CaseList cases={cases} onSelect={setSelectedId} onChanged={() => void refresh()} />
        )}

        {snapshot.cost && snapshot.cost.capPerDay > 0 ? (
          <p className="text-[10px] text-white/35" data-testid="self-heal-cost">
            Today&apos;s self-heal budget: {snapshot.cost.spentToday.toLocaleString()} /{" "}
            {snapshot.cost.capPerDay.toLocaleString()} tokens
            {snapshot.cost.exhausted ? " — spent; new triggers are queued for tomorrow" : ""}
            {snapshot.costQueue.length ? ` · ${snapshot.costQueue.length} queued` : ""}
            {snapshot.slowQueue.length ? ` · ${snapshot.slowQueue.length} waiting for the pipeline` : ""}
          </p>
        ) : null}

        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-white/35">Scope classes</div>
          <ScopeClassLegend />
        </div>
      </div>
    </div>
  );
}
