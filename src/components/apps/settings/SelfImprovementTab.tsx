"use client";

import { useCallback, useEffect, useState } from "react";

// Settings → Self Improvement (031-self-healing FR-027).
//
// Layout is binding (mockup.html §3): two columns — left Global + Triggers,
// right Autonomy + Limits. The one behavior worth calling out: when the master
// switch is off every other control is DIMMED and disabled, because the global
// kill switch really does disable all of them (FR-006) and a live-looking
// toggle that does nothing is worse than a greyed-out one.

interface Values {
  enabled: boolean;
  "triggers.explicit": boolean;
  "triggers.hardError": boolean;
  "triggers.repeatedFailure": boolean;
  "triggers.workflowTimeout": boolean;
  "triggers.logEvents": boolean;
  "diagnostician.scheduled": boolean;
  "diagnostician.idleThresholdSec": number;
  autonomousImplement: boolean;
  "tdd.required": boolean;
  "tdd.targetCoverage": number;
  costCapPerDay: number;
  dedupeWindowSec: number;
  explicitDedupeWindowSec: number;
  suspendedTimeoutDays: number;
  costQueueMax: number;
  costQueueTtlDays: number;
  "repeatedFailure.count": number;
  "repeatedFailure.windowSec": number;
  "hardError.minCount": number;
  "stuckDetector.enabled": boolean;
  "stuckDetector.repeatCalls": number;
}

/** The platform transcription switch lives in its OWN namespace (`agentRuns`):
 *  it governs every headless run BOS starts, not just self-heal's. It is
 *  surfaced here because this is where a user manages this mechanism's
 *  observability, and a transcript is what makes a stuck run diagnosable. */
interface PlatformValues {
  "transcriptions.enabled": boolean;
}

const DEFAULTS: Values = {
  enabled: true,
  "triggers.explicit": true,
  "triggers.hardError": false,
  "triggers.repeatedFailure": false,
  "triggers.workflowTimeout": false,
  "triggers.logEvents": false,
  "diagnostician.scheduled": false,
  "diagnostician.idleThresholdSec": 300,
  autonomousImplement: true,
  "tdd.required": true,
  "tdd.targetCoverage": 95,
  costCapPerDay: 1_000_000,
  dedupeWindowSec: 86_400,
  explicitDedupeWindowSec: 3_600,
  suspendedTimeoutDays: 7,
  costQueueMax: 100,
  costQueueTtlDays: 7,
  "repeatedFailure.count": 3,
  "repeatedFailure.windowSec": 300,
  "hardError.minCount": 1,
  "stuckDetector.enabled": true,
  "stuckDetector.repeatCalls": 5,
};

const PLATFORM_DEFAULTS: PlatformValues = { "transcriptions.enabled": true };

const CARD = "flex flex-col gap-3 rounded-md border border-white/10 bg-white/[0.03] p-3";
const CARD_TITLE = "text-[11px] font-semibold uppercase tracking-wide text-violet-300";
const NUM_INPUT =
  "w-32 rounded border border-white/10 bg-black/30 px-2 py-1 text-right text-[11px] text-white outline-none focus:border-white/30 disabled:opacity-40";

function Toggle({
  label,
  help,
  checked,
  disabled,
  onChange,
  testId,
}: {
  label: string;
  help: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  testId: string;
}) {
  return (
    <label className={`flex items-start justify-between gap-3 text-[11px] ${disabled ? "opacity-40" : ""}`}>
      <span className="min-w-0 flex-1">
        <span className="mb-0.5 block font-semibold text-white/90">{label}</span>
        <span className="block text-[10px] leading-snug text-white/50">{help}</span>
      </span>
      <input
        type="checkbox"
        data-testid={testId}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-[#5b8cff]"
      />
    </label>
  );
}

// Remounted via a `key` holding the initial value rather than syncing
// prop→state in an effect — the same pattern CompactionTab's NumberField and
// ToolsTab's ToolRow use.
function NumberField({
  label,
  help,
  value,
  disabled,
  clamp,
  onCommit,
  testId,
}: {
  label: string;
  help: string;
  value: number;
  disabled?: boolean;
  clamp: (n: number) => number;
  onCommit: (v: number) => void;
  testId: string;
}) {
  const [draft, setDraft] = useState(String(value));
  return (
    <label className={`flex items-start justify-between gap-3 text-[11px] ${disabled ? "opacity-40" : ""}`}>
      <span className="min-w-0 flex-1">
        <span className="mb-0.5 block font-semibold text-white/90">{label}</span>
        <span className="block text-[10px] leading-snug text-white/50">{help}</span>
      </span>
      <input
        type="number"
        data-testid={testId}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const n = Number(draft);
          if (Number.isFinite(n)) {
            const next = clamp(n);
            setDraft(String(next));
            onCommit(next);
          } else {
            setDraft(String(value));
          }
        }}
        className={NUM_INPUT}
      />
    </label>
  );
}

export function SelfImprovementTab() {
  const [values, setValues] = useState<Values>(DEFAULTS);
  const [platform, setPlatform] = useState<PlatformValues>(PLATFORM_DEFAULTS);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = (await fetch("/api/config").then((r) => r.json())) as {
        schemas?: { namespace: string; values?: Record<string, unknown> }[];
      };
      const stored = (res.schemas ?? []).find((s) => s.namespace === "selfHeal")?.values ?? {};
      setValues((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(DEFAULTS) as (keyof Values)[]) {
          const v = stored[key as string];
          if (typeof DEFAULTS[key] === "boolean" && typeof v === "boolean") {
            (next[key] as boolean) = v;
          } else if (typeof DEFAULTS[key] === "number" && typeof v === "number") {
            (next[key] as number) = v;
          }
        }
        return next;
      });
      const storedPlatform = (res.schemas ?? []).find((s) => s.namespace === "agentRuns")?.values ?? {};
      const transcripts = storedPlatform["transcriptions.enabled"];
      if (typeof transcripts === "boolean") setPlatform({ "transcriptions.enabled": transcripts });
    } catch {
      /* keep defaults — a config read failure must not blank the form */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);

  const save = useCallback((patch: Record<string, unknown>) => {
    void fetch("/api/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ namespace: "selfHeal", values: patch }),
    }).catch(() => {
      /* silently keep local state; the next load reconciles */
    });
  }, []);

  const set = useCallback(
    <K extends keyof Values>(key: K, value: Values[K]) => {
      setValues((prev) => ({ ...prev, [key]: value }));
      save({ [key]: value });
    },
    [save],
  );

  /** The transcription switch saves to its own namespace, not `selfHeal`. */
  const setPlatformValue = useCallback((value: boolean) => {
    setPlatform({ "transcriptions.enabled": value });
    void fetch("/api/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ namespace: "agentRuns", values: { "transcriptions.enabled": value } }),
    }).catch(() => {
      /* same as above: keep local state, the next load reconciles */
    });
  }, []);

  if (!loaded) return <p className="text-xs text-white/40">Loading…</p>;

  const off = !values.enabled;
  const int = (min: number, max: number) => (n: number) => Math.min(max, Math.max(min, Math.round(n)));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-1 md:flex-row" data-testid="self-improvement-tab">
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className={CARD}>
          <div className={CARD_TITLE}>Global</div>
          <Toggle
            testId="self-heal-enabled"
            label="Enable self-healing"
            help="Master switch. When off, no trigger fires, nothing is scheduled, and no tokens are spent — regardless of the settings below."
            checked={values.enabled}
            onChange={(v) => set("enabled", v)}
          />
          <p className="text-[10px] leading-snug text-white/40">
            Cases, diagnostics reports and the review controls live in Build Studio → Self-Heal. A fix always lands on a
            preview you promote yourself; the mechanism never promotes.
          </p>
        </div>

        <div className={CARD}>
          <div className={CARD_TITLE}>Triggers</div>
          <Toggle
            testId="self-heal-trigger-explicit"
            label="Explicit report"
            help="Someone (you or an agent) reports a problem via self_heal_request or the “Report a problem” button."
            checked={values["triggers.explicit"]}
            disabled={off}
            onChange={(v) => set("triggers.explicit", v)}
          />
          <Toggle
            testId="self-heal-trigger-hard-error"
            label="Hard error"
            help="One non-environmental tool error. Network, DNS, 401, 429, OOM and upstream-timeout failures are always filtered out; a permission error is not — the Diagnostician decides whether that one is yours or BrowserOS's."
            checked={values["triggers.hardError"]}
            disabled={off}
            onChange={(v) => set("triggers.hardError", v)}
          />
          <Toggle
            testId="self-heal-trigger-repeated"
            label="Repeated failure"
            help="Several consecutive failures of the same tool with the same error signature (count and window under Limits)."
            checked={values["triggers.repeatedFailure"]}
            disabled={off}
            onChange={(v) => set("triggers.repeatedFailure", v)}
          />
          <Toggle
            testId="self-heal-trigger-workflow-timeout"
            label="Workflow timeout"
            help="A workflow run or long operation exceeds its configured timeout. Needs the Workflows service to report timeouts; inert until it does."
            checked={values["triggers.workflowTimeout"]}
            disabled={off}
            onChange={(v) => set("triggers.workflowTimeout", v)}
          />
          <Toggle
            testId="self-heal-trigger-log-events"
            label="Log events"
            help="An error-level log from a BrowserOS-owned component. Third-party components (integrations, MCP servers, marketplace services) never trigger it."
            checked={values["triggers.logEvents"]}
            disabled={off}
            onChange={(v) => set("triggers.logEvents", v)}
          />
        </div>

        <div className={CARD}>
          <div className={CARD_TITLE}>Scheduled review</div>
          <Toggle
            testId="self-heal-scheduled"
            label="Run the Diagnostician on a schedule"
            help="Proactively review conversations that have gone idle for behavioral problems, and diagnose any case still waiting. Catches patterns that never threw an error."
            checked={values["diagnostician.scheduled"]}
            disabled={off}
            onChange={(v) => set("diagnostician.scheduled", v)}
          />
          <NumberField
            testId="self-heal-idle-threshold"
            key={`idle-${values["diagnostician.idleThresholdSec"]}`}
            label="Idle threshold (seconds)"
            help="How long a conversation must be untouched before the scheduled review considers it. Also sets how often the review ticks."
            value={values["diagnostician.idleThresholdSec"]}
            disabled={off || !values["diagnostician.scheduled"]}
            clamp={int(30, 86_400)}
            onCommit={(v) => set("diagnostician.idleThresholdSec", v)}
          />
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className={CARD}>
          <div className={CARD_TITLE}>Autonomy</div>
          <Toggle
            testId="self-heal-autonomous"
            label="Autonomous implement"
            help="Let a diagnosed core or owned-app gap run the whole Build Studio pipeline unattended, all the way to a built preview. Off means a diagnosed case waits for your go-ahead instead."
            checked={values.autonomousImplement}
            disabled={off}
            onChange={(v) => set("autonomousImplement", v)}
          />
          <Toggle
            testId="self-heal-tdd-required"
            label="TDD required"
            help="Instruct the developer to write the failing test first and watch it fail, then implement. A test written after the fix does not prove the fix."
            checked={values["tdd.required"]}
            disabled={off}
            onChange={(v) => set("tdd.required", v)}
          />
          <NumberField
            testId="self-heal-coverage"
            key={`cov-${values["tdd.targetCoverage"]}`}
            label="Coverage target (%)"
            help="Minimum line and branch coverage on the files a fix modifies."
            value={values["tdd.targetCoverage"]}
            disabled={off || !values["tdd.required"]}
            clamp={int(0, 100)}
            onCommit={(v) => set("tdd.targetCoverage", v)}
          />
        </div>

        <div className={CARD}>
          <div className={CARD_TITLE}>Limits</div>
          <NumberField
            testId="self-heal-cost-cap"
            key={`cap-${values.costCapPerDay}`}
            label="Cost cap (tokens / day)"
            help="Total self-heal token budget per UTC day. Once spent, new triggers are queued for the next day rather than dropped — and a fix already running finishes, so one big case can overshoot. 0 means no cap."
            value={values.costCapPerDay}
            disabled={off}
            clamp={int(0, 1_000_000_000)}
            onCommit={(v) => set("costCapPerDay", v)}
          />
          <NumberField
            testId="self-heal-dedupe-window"
            key={`ded-${values.dedupeWindowSec}`}
            label="Dedupe window (seconds)"
            help="The same failure signature creates at most one case inside this window. A suppressed trigger is still logged and linked to the original case."
            value={values.dedupeWindowSec}
            disabled={off}
            clamp={int(0, 30 * 86_400)}
            onCommit={(v) => set("dedupeWindowSec", v)}
          />
          <NumberField
            testId="self-heal-explicit-dedupe-window"
            key={`edd-${values.explicitDedupeWindowSec}`}
            label="Dedupe window, explicit reports (seconds)"
            help="Shorter on purpose: reporting the same problem again yourself is usually deliberate, so it becomes a new case sooner."
            value={values.explicitDedupeWindowSec}
            disabled={off}
            clamp={int(0, 30 * 86_400)}
            onCommit={(v) => set("explicitDedupeWindowSec", v)}
          />
          <NumberField
            testId="self-heal-suspend-days"
            key={`sus-${values.suspendedTimeoutDays}`}
            label="Suspended timeout (days)"
            help="How long a fix waiting on your answer is held. After this it is abandoned and the single pipeline slot is freed for the next fix."
            value={values.suspendedTimeoutDays}
            disabled={off}
            clamp={int(1, 365)}
            onCommit={(v) => set("suspendedTimeoutDays", v)}
          />
          <NumberField
            testId="self-heal-queue-max"
            key={`qmax-${values.costQueueMax}`}
            label="Queue size limit"
            help="Maximum cases waiting on the next day's budget. Beyond this the oldest is evicted — and announced, never silently dropped."
            value={values.costQueueMax}
            disabled={off}
            clamp={int(1, 10_000)}
            onCommit={(v) => set("costQueueMax", v)}
          />
          <NumberField
            testId="self-heal-queue-ttl"
            key={`qttl-${values.costQueueTtlDays}`}
            label="Queue TTL (days)"
            help="A case queued longer than this is evicted regardless of its position in the queue."
            value={values.costQueueTtlDays}
            disabled={off}
            clamp={int(1, 365)}
            onCommit={(v) => set("costQueueTtlDays", v)}
          />
        </div>

        <div className={CARD}>
          <div className={CARD_TITLE}>Stuck-run detection</div>
          <Toggle
            testId="self-heal-stuck-enabled"
            label="Detect stuck runs"
            help="Watch the runs this mechanism starts for the same tool call repeating with no progress, or a run that uses up its whole step budget, and flag the case so you can Stop it. Deterministic — no extra model call. Stop and Start still work with this off."
            checked={values["stuckDetector.enabled"]}
            disabled={off}
            onChange={(v) => set("stuckDetector.enabled", v)}
          />
          <NumberField
            testId="self-heal-stuck-repeat-calls"
            key={`sd-${values["stuckDetector.repeatCalls"]}`}
            label="Identical calls before flagging"
            help="How many times the same call (ignoring ids, timestamps and numbers) must repeat back-to-back before the run is flagged. Lower catches a loop sooner; too low flags an ordinary retry."
            value={values["stuckDetector.repeatCalls"]}
            disabled={off || !values["stuckDetector.enabled"]}
            clamp={int(3, 50)}
            onCommit={(v) => set("stuckDetector.repeatCalls", v)}
          />
          <Toggle
            testId="agent-runs-transcriptions-enabled"
            label="Record run transcripts"
            help="Write one markdown transcript per headless run (data/agent-transcripts/…) — the task, every tool call and result, the final text — readable while the run is still going, in Build Studio → Self-Heal. Governs ALL headless runs, not only self-healing ones. Off means nothing is recorded and a stuck run cannot be inspected after the fact."
            checked={platform["transcriptions.enabled"]}
            onChange={(v) => setPlatformValue(v)}
          />
        </div>

        <div className={CARD}>
          <div className={CARD_TITLE}>Hard-error detection</div>
          <NumberField
            testId="self-heal-hard-error-min-count"
            key={`hemc-${values["hardError.minCount"]}`}
            label="Failures before a case"
            help="How many non-environmental failures inside the window below the hard-error trigger needs before it opens a case. 1 fires on a single failure; below the count the failure is logged, never a case."
            value={values["hardError.minCount"]}
            disabled={off || !values["triggers.hardError"]}
            clamp={int(1, 100)}
            onCommit={(v) => set("hardError.minCount", v)}
          />
        </div>

        <div className={CARD}>
          <div className={CARD_TITLE}>Repeated-failure detection</div>
          <NumberField
            testId="self-heal-repeat-count"
            key={`rc-${values["repeatedFailure.count"]}`}
            label="Consecutive failures"
            help="How many same-signature failures in a row trip the repeated-failure trigger. A success in between resets the streak."
            value={values["repeatedFailure.count"]}
            disabled={off || !values["triggers.repeatedFailure"]}
            clamp={int(2, 100)}
            onCommit={(v) => set("repeatedFailure.count", v)}
          />
          <NumberField
            testId="self-heal-repeat-window"
            key={`rw-${values["repeatedFailure.windowSec"]}`}
            label="Window (seconds)"
            help="The rolling window those failures must fall inside."
            value={values["repeatedFailure.windowSec"]}
            disabled={off || !values["triggers.repeatedFailure"]}
            clamp={int(10, 86_400)}
            onCommit={(v) => set("repeatedFailure.windowSec", v)}
          />
        </div>
      </div>
    </div>
  );
}
