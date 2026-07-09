"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle,
  Clock,
  Info,
  Loader2,
  Play,
  RotateCcw,
  Save,
  Sliders,
  X,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ConfigSchemaView } from "@/lib/config/types";

// Keys used both in the config-registry payload and in the local editor state.
// The registry stores dotted paths for nested groups (fastLoop.*, slowLoop.*),
// matching the shape validated in src/lib/config/registry.ts.
type ConfigKey =
  | "fastLoop.enabled"
  | "fastLoop.tickIntervalSec"
  | "fastLoop.idleThresholdSec"
  | "fastLoop.turnCap"
  | "fastLoop.minNewTurns"
  | "slowLoop.enabled"
  | "slowLoop.intervalSec"
  | "slowLoop.batchSize"
  | "modelOverride"
  | "episodeArchiveAgeDays"
  | "topicBudget";

// Mirrors memoryLoopsDefaults() from src/lib/agent/memory/config.ts. Duplicated
// so the client can reset without an extra round trip.
const DEFAULTS: Record<ConfigKey, unknown> = {
  "fastLoop.enabled": true,
  "fastLoop.tickIntervalSec": 120,
  "fastLoop.idleThresholdSec": 300,
  "fastLoop.turnCap": 40,
  "fastLoop.minNewTurns": 4,
  "slowLoop.enabled": true,
  "slowLoop.intervalSec": 3600,
  "slowLoop.batchSize": 10,
  modelOverride: "",
  episodeArchiveAgeDays: 14,
  topicBudget: 4000,
};

interface LogRecord {
  ts: number;
  level: string;
  component: string;
  msg: string;
  data?: unknown;
}

interface LogsResponse {
  ok?: boolean;
  records?: LogRecord[];
}

interface FastLoopStats {
  scanned?: number;
  eligible?: number;
  reviewed?: number;
  episodesUpdated?: number;
  skillsPatched?: number;
}

interface SlowLoopStats {
  processed?: number;
  memoryOps?: number;
  topicOps?: number;
  skillsPatched?: number;
  skillsCreated?: number;
  skillsRefused?: number;
  archived?: number;
  errors?: number;
}

interface FeedbackMsg {
  tone: "success" | "error";
  text: string;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default function LoopsTab({ agentId }: { agentId?: string } = {}) {
  const [schema, setSchema] = useState<ConfigSchemaView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [values, setValues] = useState<Record<ConfigKey, unknown>>(
    () => ({ ...DEFAULTS }) as Record<ConfigKey, unknown>,
  );
  const [savedValues, setSavedValues] = useState<Record<ConfigKey, unknown>>(
    () => ({ ...DEFAULTS }) as Record<ConfigKey, unknown>,
  );
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<FeedbackMsg | null>(null);
  const [resetConfirming, setResetConfirming] = useState(false);

  const [fastLog, setFastLog] = useState<LogRecord | null>(null);
  const [slowLog, setSlowLog] = useState<LogRecord | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);

  const [fastRunning, setFastRunning] = useState(false);
  const [slowRunning, setSlowRunning] = useState(false);
  const [runMsg, setRunMsg] = useState<FeedbackMsg | null>(null);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/config");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { schemas?: ConfigSchemaView[] };
      const s = (data.schemas || []).find((x) => x.namespace === "memoryLoops") || null;
      if (!s) throw new Error("memoryLoops namespace not registered");
      setSchema(s);
      const next = { ...DEFAULTS } as Record<ConfigKey, unknown>;
      for (const k of Object.keys(DEFAULTS) as ConfigKey[]) {
        if (k in s.values) next[k] = s.values[k];
      }
      setValues(next);
      setSavedValues(next);
    } catch (err) {
      setLoadError((err as Error).message || "Failed to load configuration");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const [fastRes, slowRes] = await Promise.all([
        fetch("/api/logs?component=memory.fast-loop&limit=50").then(safeJson),
        fetch("/api/logs?component=memory.slow-loop&limit=50").then(safeJson),
      ]);
      setFastLog(pickLatestRun(fastRes, "fast loop run"));
      setSlowLog(pickLatestRun(slowRes, "slow loop run"));
    } catch {
      // Log history is best-effort; leave whatever is set.
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    const id = setTimeout(() => {
      void loadConfig();
      void loadHistory();
    }, 0);
    return () => clearTimeout(id);
  }, [loadConfig, loadHistory]);

  const dirty = useMemo(() => !shallowEqual(values, savedValues), [values, savedValues]);
  const resetPreview = useMemo(() => !shallowEqual(values, DEFAULTS), [values]);

  const setField = <K extends ConfigKey>(key: K, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setSaveMsg(null);
  };

  const onSave = async () => {
    if (!schema) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await fetch("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ namespace: "memoryLoops", values }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        values?: Record<string, unknown>;
      };
      if (!res.ok || data.error) {
        setSaveMsg({ tone: "error", text: data.error || `Failed (HTTP ${res.status})` });
        return;
      }
      if (data.values) {
        const next = { ...values };
        for (const k of Object.keys(DEFAULTS) as ConfigKey[]) {
          if (k in data.values) next[k] = data.values[k];
        }
        setValues(next);
        setSavedValues(next);
      } else {
        setSavedValues({ ...values });
      }
      setSaveMsg({ tone: "success", text: "Configuration saved." });
    } catch (err) {
      setSaveMsg({ tone: "error", text: (err as Error).message || "Failed to save" });
    } finally {
      setSaving(false);
    }
  };

  const onReset = () => {
    if (!resetConfirming) {
      setResetConfirming(true);
      return;
    }
    setValues({ ...DEFAULTS } as Record<ConfigKey, unknown>);
    setResetConfirming(false);
    setSaveMsg({ tone: "success", text: "Defaults restored. Click Save to persist." });
  };

  const onRunFast = async () => {
    setFastRunning(true);
    setRunMsg(null);
    try {
      const res = await fetch("/api/assistant/reflect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runAll: true }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        reason?: string;
        reviewed?: number;
        scanned?: number;
      };
      if (!res.ok || data.error) {
        setRunMsg({ tone: "error", text: data.error || `Failed (HTTP ${res.status})` });
        return;
      }
      const summary = data.reason
        ? `Fast loop: ${data.reason}`
        : `Fast loop reviewed ${data.reviewed ?? 0} of ${data.scanned ?? 0} conversation${data.scanned === 1 ? "" : "s"}.`;
      setRunMsg({ tone: "success", text: summary });
      void loadHistory();
    } catch (err) {
      setRunMsg({ tone: "error", text: (err as Error).message || "Failed to run fast loop" });
    } finally {
      setFastRunning(false);
    }
  };

  const onRunSlow = async () => {
    setSlowRunning(true);
    setRunMsg(null);
    try {
      const res = await fetch("/api/memory/consolidate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        reason?: string;
        processed?: number;
      };
      if (!res.ok || data.error) {
        setRunMsg({ tone: "error", text: data.error || `Failed (HTTP ${res.status})` });
        return;
      }
      const summary = data.reason
        ? `Slow loop: ${data.reason}`
        : `Slow loop processed ${data.processed ?? 0} episode${data.processed === 1 ? "" : "s"}.`;
      setRunMsg({ tone: "success", text: summary });
      void loadHistory();
    } catch (err) {
      setRunMsg({ tone: "error", text: (err as Error).message || "Failed to run slow loop" });
    } finally {
      setSlowRunning(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[11px] text-white/40">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading configuration…
      </div>
    );
  }

  if (loadError || !schema) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-[11px] text-white/60">
        <AlertTriangle className="h-5 w-5 text-red-300" />
        <span>Failed to load configuration: {loadError}</span>
        <button
          type="button"
          onClick={() => void loadConfig()}
          className="rounded-md border border-white/10 bg-white/[0.05] px-3 py-1.5 text-[11px] text-white/80 hover:bg-white/10"
        >
          Retry
        </button>
      </div>
    );
  }

  const fastEnabled = !!values["fastLoop.enabled"];
  const slowEnabled = !!values["slowLoop.enabled"];

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 text-xs">
      <ConfigSection
        icon={Zap}
        iconClass="text-amber-300"
        title="Fast Loop Configuration"
        subtitle="Reviews idle conversations and writes episodic memories."
      >
        <ToggleField
          label="Enable Fast Loop"
          checked={fastEnabled}
          onChange={(v) => setField("fastLoop.enabled", v)}
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <NumberField
            label="Tick Interval (seconds)"
            value={num(values["fastLoop.tickIntervalSec"], 120)}
            min={30}
            disabled={!fastEnabled}
            onChange={(v) => setField("fastLoop.tickIntervalSec", v)}
            hint="How often the fast loop wakes up."
          />
          <NumberField
            label="Idle Threshold (seconds)"
            value={num(values["fastLoop.idleThresholdSec"], 300)}
            min={0}
            disabled={!fastEnabled}
            onChange={(v) => setField("fastLoop.idleThresholdSec", v)}
            hint="Minimum idle time before a conversation is eligible."
          />
          <NumberField
            label="Unreviewed Turn Cap"
            value={num(values["fastLoop.turnCap"], 40)}
            min={1}
            disabled={!fastEnabled}
            onChange={(v) => setField("fastLoop.turnCap", v)}
            hint="Force a review after this many unreviewed turns."
          />
          <NumberField
            label="Min New Turns to Review"
            value={num(values["fastLoop.minNewTurns"], 4)}
            min={1}
            disabled={!fastEnabled}
            onChange={(v) => setField("fastLoop.minNewTurns", v)}
            hint="Skip conversations with fewer new assistant turns."
          />
        </div>
      </ConfigSection>

      <ConfigSection
        icon={Clock}
        iconClass="text-sky-300"
        title="Slow Loop Configuration"
        subtitle="Consolidates pending episodes into topic-sharded long-term memory."
      >
        <ToggleField
          label="Enable Slow Loop"
          checked={slowEnabled}
          onChange={(v) => setField("slowLoop.enabled", v)}
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <NumberField
            label="Interval (seconds)"
            value={num(values["slowLoop.intervalSec"], 3600)}
            min={60}
            disabled={!slowEnabled}
            onChange={(v) => setField("slowLoop.intervalSec", v)}
            hint="How often the slow loop runs."
          />
          <NumberField
            label="Batch Size (episodes per run)"
            value={num(values["slowLoop.batchSize"], 10)}
            min={1}
            disabled={!slowEnabled}
            onChange={(v) => setField("slowLoop.batchSize", v)}
            hint="Max pending episodes processed per run."
          />
        </div>
      </ConfigSection>

      <ConfigSection
        icon={Sliders}
        iconClass="text-violet-300"
        title="Advanced Settings"
        subtitle="Applies to both loops."
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <NumberField
            label="Episode Archive Age (days)"
            value={num(values.episodeArchiveAgeDays, 14)}
            min={1}
            onChange={(v) => setField("episodeArchiveAgeDays", v)}
            hint="Consolidated episodes older than this move to .Archive/."
          />
          <NumberField
            label="Topic Budget (chars)"
            value={num(values.topicBudget, 4000)}
            min={500}
            onChange={(v) => setField("topicBudget", v)}
            hint="Per-topic character budget before sharding."
          />
        </div>
        <TextField
          label="Model Override (optional)"
          value={String(values.modelOverride ?? "")}
          placeholder="(none — uses provider default)"
          onChange={(v) => setField("modelOverride", v)}
          hint="Override the model used by both loops. Leave blank for provider default."
        />
      </ConfigSection>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onSave}
          disabled={saving || !dirty}
          className="flex items-center gap-1.5 rounded-md bg-white/15 px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-white/25 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
          {saving ? "Saving…" : "Save Configuration"}
        </button>
        <button
          type="button"
          onClick={onReset}
          onBlur={() => setResetConfirming(false)}
          disabled={saving || (!resetPreview && !resetConfirming)}
          className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            resetConfirming
              ? "border-amber-400/40 bg-amber-400/10 text-amber-100 hover:bg-amber-400/20"
              : "border-white/10 bg-white/[0.05] text-white/80 hover:bg-white/10"
          }`}
        >
          <RotateCcw className="h-3 w-3" />
          {resetConfirming ? "Click again to confirm reset" : "Reset Defaults"}
        </button>
        {dirty && !saveMsg && (
          <span className="text-[10px] text-amber-200/80">Unsaved changes</span>
        )}
        {saveMsg && (
          <StatusPill tone={saveMsg.tone} text={saveMsg.text} onDismiss={() => setSaveMsg(null)} />
        )}
      </div>

      <ConfigSection
        icon={Activity}
        iconClass="text-emerald-300"
        title="Run History"
        subtitle="Latest execution summaries from the central log."
      >
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <HistoryCard
            icon={Zap}
            iconClass="text-amber-300"
            label="Fast Loop"
            log={fastLog}
            loading={historyLoading}
            renderStats={renderFastStats}
          />
          <HistoryCard
            icon={Clock}
            iconClass="text-sky-300"
            label="Slow Loop"
            log={slowLog}
            loading={historyLoading}
            renderStats={renderSlowStats}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onRunFast}
            disabled={fastRunning || slowRunning}
            className="flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.05] px-3 py-1.5 text-[11px] font-medium text-white/85 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {fastRunning ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            Run Fast Loop Now
          </button>
          <button
            type="button"
            onClick={onRunSlow}
            disabled={fastRunning || slowRunning}
            className="flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.05] px-3 py-1.5 text-[11px] font-medium text-white/85 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {slowRunning ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            Run Slow Loop Now
          </button>
          {runMsg && (
            <StatusPill tone={runMsg.tone} text={runMsg.text} onDismiss={() => setRunMsg(null)} />
          )}
        </div>
      </ConfigSection>

      <InfoBanner values={values} />
    </div>
  );
}

// ── Sections & primitives ──────────────────────────────────────────────

function ConfigSection({
  icon: Icon,
  iconClass,
  title,
  subtitle,
  children,
}: {
  icon: LucideIcon;
  iconClass: string;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
      <header className="mb-3 flex items-start gap-2 border-b border-white/10 pb-2">
        <Icon className={`mt-[1px] h-3.5 w-3.5 ${iconClass}`} />
        <div className="flex flex-col">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-white/85">
            {title}
          </h2>
          {subtitle && <span className="mt-0.5 text-[10px] text-white/45">{subtitle}</span>}
        </div>
      </header>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

function ToggleField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-2 text-left transition-colors hover:bg-white/[0.06]"
    >
      <span
        aria-hidden="true"
        className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${
          checked ? "bg-emerald-400/70" : "bg-white/15"
        }`}
      >
        <span
          className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-all ${
            checked ? "left-3.5" : "left-0.5"
          }`}
        />
      </span>
      <span className="flex-1 text-[11px] font-medium text-white/90">{label}</span>
      <span className={`text-[10px] ${checked ? "text-emerald-300" : "text-white/40"}`}>
        {checked ? "Enabled" : "Disabled"}
      </span>
    </button>
  );
}

function NumberField({
  label,
  value,
  min,
  disabled,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  min?: number;
  disabled?: boolean;
  onChange: (v: number) => void;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-wider text-white/55">
        {label}
      </span>
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        min={min}
        disabled={disabled}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
        className="rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-white outline-none transition-colors focus:border-white/30 disabled:cursor-not-allowed disabled:opacity-50"
      />
      {hint && <span className="text-[10px] text-white/40">{hint}</span>}
    </label>
  );
}

function TextField({
  label,
  value,
  placeholder,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-wider text-white/55">
        {label}
      </span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-white placeholder-white/30 outline-none transition-colors focus:border-white/30"
      />
      {hint && <span className="text-[10px] text-white/40">{hint}</span>}
    </label>
  );
}

// ── History ────────────────────────────────────────────────────────────

function HistoryCard({
  icon: Icon,
  iconClass,
  label,
  log,
  loading,
  renderStats,
}: {
  icon: LucideIcon;
  iconClass: string;
  label: string;
  log: LogRecord | null;
  loading: boolean;
  renderStats: (log: LogRecord) => Array<{ text: string; tone?: "ok" | "warn" }>;
}) {
  return (
    <div className="flex flex-col rounded-md border border-white/10 bg-white/[0.03] p-2.5">
      <div className="flex items-center justify-between text-[11px]">
        <span className="flex items-center gap-1.5 font-medium text-white/90">
          <Icon className={`h-3 w-3 ${iconClass}`} />
          {label}
        </span>
        <span className="text-[10px] text-white/50">
          {loading ? "…" : log ? relativeTime(log.ts) : "no runs yet"}
        </span>
      </div>
      <div className="mt-2 flex flex-col gap-1 text-[10.5px] text-white/70">
        {loading ? (
          <span className="italic text-white/40">Loading…</span>
        ) : log ? (
          renderStats(log).map((stat, i) => (
            <span
              key={i}
              className={
                stat.tone === "warn"
                  ? "text-amber-200/90"
                  : "text-white/70"
              }
            >
              {stat.text}
            </span>
          ))
        ) : (
          <span className="italic text-white/40">
            No summary yet — this loop hasn&apos;t run since logging was enabled.
          </span>
        )}
      </div>
    </div>
  );
}

function renderFastStats(log: LogRecord): Array<{ text: string; tone?: "ok" | "warn" }> {
  const d = (log.data ?? {}) as FastLoopStats;
  const out: Array<{ text: string; tone?: "ok" | "warn" }> = [];
  out.push({ text: `Scanned: ${d.scanned ?? 0} conversation${d.scanned === 1 ? "" : "s"}` });
  out.push({ text: `Reviewed: ${d.reviewed ?? 0} · Eligible: ${d.eligible ?? 0}` });
  if ((d.episodesUpdated ?? 0) > 0)
    out.push({ text: `Episodes updated: ${d.episodesUpdated}` });
  if ((d.skillsPatched ?? 0) > 0)
    out.push({ text: `Skills patched: ${d.skillsPatched}` });
  return out;
}

function renderSlowStats(log: LogRecord): Array<{ text: string; tone?: "ok" | "warn" }> {
  const d = (log.data ?? {}) as SlowLoopStats;
  const out: Array<{ text: string; tone?: "ok" | "warn" }> = [];
  out.push({ text: `Processed: ${d.processed ?? 0} episode${d.processed === 1 ? "" : "s"}` });
  if ((d.topicOps ?? 0) > 0 || (d.memoryOps ?? 0) > 0)
    out.push({ text: `Ops — memory: ${d.memoryOps ?? 0} · topics: ${d.topicOps ?? 0}` });
  if ((d.skillsPatched ?? 0) > 0 || (d.skillsCreated ?? 0) > 0)
    out.push({
      text: `Skills — patched: ${d.skillsPatched ?? 0} · created: ${d.skillsCreated ?? 0}`,
    });
  if ((d.skillsRefused ?? 0) > 0)
    out.push({ text: `Refusals: ${d.skillsRefused}`, tone: "warn" });
  if ((d.archived ?? 0) > 0)
    out.push({ text: `Archived: ${d.archived}` });
  if ((d.errors ?? 0) > 0)
    out.push({ text: `Errors: ${d.errors}`, tone: "warn" });
  return out;
}

// ── Banner + Status pill ──────────────────────────────────────────────

function InfoBanner({ values }: { values: Record<ConfigKey, unknown> }) {
  const fastEnabled = !!values["fastLoop.enabled"];
  const slowEnabled = !!values["slowLoop.enabled"];
  if (!fastEnabled && !slowEnabled) {
    return (
      <div className="flex shrink-0 items-start gap-2 rounded-md border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-[11px] text-amber-100">
        <AlertTriangle className="mt-[1px] h-3.5 w-3.5 shrink-0 text-amber-300" />
        <span>
          Both loops are <strong className="font-semibold">disabled</strong>. Episodes will not be
          captured or consolidated until you re-enable them or run them manually.
        </span>
      </div>
    );
  }
  if (!fastEnabled) {
    return (
      <div className="flex shrink-0 items-start gap-2 rounded-md border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-[11px] text-amber-100">
        <Info className="mt-[1px] h-3.5 w-3.5 shrink-0 text-amber-300" />
        <span>Fast loop is disabled — new episodes won&apos;t be captured automatically.</span>
      </div>
    );
  }
  if (!slowEnabled) {
    return (
      <div className="flex shrink-0 items-start gap-2 rounded-md border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-[11px] text-amber-100">
        <Info className="mt-[1px] h-3.5 w-3.5 shrink-0 text-amber-300" />
        <span>Slow loop is disabled — pending episodes won&apos;t be consolidated automatically.</span>
      </div>
    );
  }
  return (
    <div className="flex shrink-0 items-start gap-2 rounded-md border border-emerald-400/25 bg-emerald-400/10 px-3 py-2 text-[11px] text-emerald-100">
      <CheckCircle className="mt-[1px] h-3.5 w-3.5 shrink-0 text-emerald-300" />
      <span>
        Both loops are enabled. Configuration changes take effect on the next tick.
      </span>
    </div>
  );
}

function StatusPill({
  tone,
  text,
  onDismiss,
}: {
  tone: "success" | "error";
  text: string;
  onDismiss?: () => void;
}) {
  const ok = tone === "success";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10.5px] ${
        ok
          ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100"
          : "border-red-400/30 bg-red-400/10 text-red-100"
      }`}
    >
      {ok ? <CheckCircle className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
      <span className="max-w-[28ch] truncate" title={text}>
        {text}
      </span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="rounded p-0.5 hover:bg-white/10"
          aria-label="Dismiss"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────

function num(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function shallowEqual<T extends Record<string, unknown>>(a: T, b: T): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

async function safeJson(res: Response): Promise<LogsResponse> {
  try {
    return (await res.json()) as LogsResponse;
  } catch {
    return { records: [] };
  }
}

function pickLatestRun(payload: LogsResponse, msg: string): LogRecord | null {
  const records = Array.isArray(payload.records) ? payload.records : [];
  const match = records.filter((r) => r.msg === msg);
  if (match.length === 0) return null;
  return match.reduce((a, b) => (a.ts >= b.ts ? a : b));
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.floor(hr / 24);
  return `${day} day${day === 1 ? "" : "s"} ago`;
}
