"use client";

import { useCallback, useEffect, useState } from "react";
import { CompactionBudgetIllustration } from "./CompactionBudgetIllustration";

// Settings → Context Compaction: how the server keeps a growing conversation
// within the model's context window. Layer 1 clears old tool results, Layer 2
// folds old turns into small block summaries (each summarized exactly once —
// never re-folded, so quality never degrades and cost per event stays flat),
// Layer 2b permanently expels the oldest block summaries once too many are
// retained, Layer 3 truncates as a last-resort safety valve.

interface CompactionValues {
  enabled: boolean;
  assumedContextTokens: number;
  clearThreshold: number;
  summarizeThreshold: number;
  hardLimit: number;
  keepToolResults: number;
  keepTailTurns: number;
  tailBudgetFraction: number;
  unrecoverableTools: string;
  model: string;
  lockStalenessMs: number;
  blockSize: number;
  maxRetainedBlocks: number;
}

const DEFAULTS: CompactionValues = {
  enabled: true,
  assumedContextTokens: 128_000,
  clearThreshold: 0.5,
  summarizeThreshold: 0.75,
  hardLimit: 0.92,
  keepToolResults: 2,
  keepTailTurns: 3,
  tailBudgetFraction: 0.2,
  unrecoverableTools: "",
  model: "",
  lockStalenessMs: 600_000,
  blockSize: 5,
  maxRetainedBlocks: 8,
};

const LABEL = "mb-1 block text-xs text-white/60";
const HELP = "mb-2 text-[11px] leading-snug text-white/40";
const CARD = "flex flex-col gap-3 rounded-md border border-white/10 bg-white/[0.03] p-3";
const CARD_TITLE = "text-[11px] font-semibold uppercase tracking-wide text-violet-300";
const NUM_INPUT = "w-28 rounded border border-white/10 bg-black/30 px-2 py-1 text-right text-[11px] text-white outline-none focus:border-white/30";
const TEXT_INPUT = "w-full rounded-md border border-white/10 bg-white/[0.05] px-2.5 py-1.5 text-sm text-white/90 outline-none focus:border-white/20 focus:bg-white/[0.08]";

function Slider({ label, help, value, min, max, step, onChange }: {
  label: string; help: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className={LABEL}>{label} <span className="ml-1 text-white/40">{value.toFixed(2)}</span></label>
      <p className={HELP}>{help}</p>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} className="w-full accent-[#5b8cff]" />
    </div>
  );
}

// Remounted (via a `key` keeping the initial value) rather than syncing
// prop→state in an effect — the same pattern ToolsTab.tsx's ToolRow uses.
function NumberField({ label, help, value, onCommit }: {
  label: string; help: string; value: number; onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  return (
    <label className="flex items-start justify-between gap-3 text-[11px] text-white/80">
      <span className="min-w-0 flex-1">
        <span className="mb-0.5 block font-semibold text-white/90">{label}</span>
        <span className="block text-[10px] leading-snug text-white/50">{help}</span>
      </span>
      <input
        type="number"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const n = Number(draft);
          if (Number.isFinite(n)) onCommit(n);
          else setDraft(String(value));
        }}
        className={NUM_INPUT}
      />
    </label>
  );
}

export function CompactionTab() {
  const [values, setValues] = useState<CompactionValues>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = (await fetch("/api/config").then((r) => r.json())) as {
        schemas?: { namespace: string; values?: Record<string, unknown> }[];
      };
      const schema = (res.schemas ?? []).find((s) => s.namespace === "compaction");
      const v = schema?.values ?? {};
      setValues({
        enabled: typeof v.enabled === "boolean" ? v.enabled : DEFAULTS.enabled,
        assumedContextTokens: typeof v.assumedContextTokens === "number" ? v.assumedContextTokens : DEFAULTS.assumedContextTokens,
        clearThreshold: typeof v.clearThreshold === "number" ? v.clearThreshold : DEFAULTS.clearThreshold,
        summarizeThreshold: typeof v.summarizeThreshold === "number" ? v.summarizeThreshold : DEFAULTS.summarizeThreshold,
        hardLimit: typeof v.hardLimit === "number" ? v.hardLimit : DEFAULTS.hardLimit,
        keepToolResults: typeof v.keepToolResults === "number" ? v.keepToolResults : DEFAULTS.keepToolResults,
        keepTailTurns: typeof v.keepTailTurns === "number" ? v.keepTailTurns : DEFAULTS.keepTailTurns,
        tailBudgetFraction: typeof v.tailBudgetFraction === "number" ? v.tailBudgetFraction : DEFAULTS.tailBudgetFraction,
        unrecoverableTools: Array.isArray(v.unrecoverableTools) ? v.unrecoverableTools.join(", ") : typeof v.unrecoverableTools === "string" ? v.unrecoverableTools : DEFAULTS.unrecoverableTools,
        model: typeof v.model === "string" ? v.model : DEFAULTS.model,
        lockStalenessMs: typeof v.lockStalenessMs === "number" ? v.lockStalenessMs : DEFAULTS.lockStalenessMs,
        blockSize: typeof v.blockSize === "number" ? v.blockSize : DEFAULTS.blockSize,
        maxRetainedBlocks: typeof v.maxRetainedBlocks === "number" ? v.maxRetainedBlocks : DEFAULTS.maxRetainedBlocks,
      });
    } catch {
      /* keep defaults */
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
      body: JSON.stringify({ namespace: "compaction", values: patch }),
    }).catch(() => { /* silently keep local state */ });
  }, []);

  const set = useCallback(<K extends keyof CompactionValues>(key: K, value: CompactionValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    save({ [key]: value });
  }, [save]);

  if (!loaded) return <p className="text-xs text-white/40">Loading…</p>;

  return (
    <div className="flex min-h-0 flex-1 gap-4 overflow-y-auto p-1">
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className={CARD}>
          <div className={CARD_TITLE}>Global</div>
          <label className="flex items-center justify-between text-[11px] text-white/80">
            <span>
              <span className="mb-0.5 block font-semibold text-white/90">Enabled</span>
              <span className="block text-[10px] text-white/50">Master switch. When off, the pipeline is a pass-through — nothing is cleared, summarized, or truncated.</span>
            </span>
            <input type="checkbox" checked={values.enabled} onChange={(e) => set("enabled", e.target.checked)} className="h-4 w-4 accent-[#5b8cff]" />
          </label>
          <NumberField
            key={values.assumedContextTokens}
            label="Assumed context window (tokens)"
            help="Used when the provider does not declare a context size."
            value={values.assumedContextTokens}
            onCommit={(v) => set("assumedContextTokens", Math.max(1024, Math.round(v)))}
          />
        </div>

        <div className={CARD}>
          <div className={CARD_TITLE}>Layer 1 — clear old tool results</div>
          <Slider
            label="Clear threshold"
            help="Once the transcript passes this fraction of the budget, tool results older than the recency window below get replaced with a short placeholder — cheap and synchronous, no LLM call."
            value={values.clearThreshold} min={0} max={1} step={0.01}
            onChange={(v) => set("clearThreshold", v)}
          />
          <NumberField
            key={values.keepToolResults}
            label="Keep last N tool-result pairs"
            help="Tool results newer than this many pairs are always kept verbatim."
            value={values.keepToolResults}
            onCommit={(v) => set("keepToolResults", Math.max(0, Math.round(v)))}
          />
        </div>

        <div className={CARD}>
          <div className={CARD_TITLE}>Layer 2 — block summarization &amp; eviction</div>
          <Slider
            label="Summarize threshold"
            help="Once the transcript passes this fraction of the budget, the oldest full block of turns is folded into a summary in the background (async — doesn't block the response)."
            value={values.summarizeThreshold} min={0} max={1} step={0.01}
            onChange={(v) => set("summarizeThreshold", v)}
          />
          <NumberField
            key={values.blockSize}
            label="Block size (turns)"
            help="How many turns get folded into one summary at a time. Each block is summarized exactly once from its raw turns — never re-summarized — so quality doesn't degrade as the conversation grows. Smaller blocks summarize faster and more often; larger blocks make fewer, longer-lived summaries."
            value={values.blockSize}
            onCommit={(v) => set("blockSize", Math.max(1, Math.round(v)))}
          />
          <NumberField
            key={values.maxRetainedBlocks}
            label="Max retained blocks"
            help="How many block summaries are kept before the oldest is permanently discarded — no trace, no further degradation. Raising this keeps more distant history around at the cost of a larger prompt every turn."
            value={values.maxRetainedBlocks}
            onCommit={(v) => set("maxRetainedBlocks", Math.max(1, Math.round(v)))}
          />
          <NumberField
            key={values.lockStalenessMs}
            label="Lock staleness (ms)"
            help="How long a stale block-formation lock is honored before another request reclaims it."
            value={values.lockStalenessMs}
            onCommit={(v) => set("lockStalenessMs", Math.max(1000, Math.round(v)))}
          />
          <label className="block text-[11px] text-white/80">
            <span className="mb-0.5 block font-semibold text-white/90">Summarizer model override</span>
            <span className="mb-1 block text-[10px] text-white/50">Optional cheaper model id for block summarization. Leave blank to use the main model.</span>
            <input
              type="text"
              defaultValue={values.model}
              onBlur={(e) => set("model", e.target.value)}
              placeholder="(use main model)"
              className={TEXT_INPUT}
            />
          </label>
        </div>

        <div className={CARD}>
          <div className={CARD_TITLE}>Layer 3 — hard-limit fallback</div>
          <Slider
            label="Hard limit"
            help="If the transcript is still over this fraction of the budget after Layers 1/2, it's truncated synchronously (oldest turns first) so the request never exceeds the model's window. This always runs in a single pass — no retries."
            value={values.hardLimit} min={0} max={1} step={0.01}
            onChange={(v) => set("hardLimit", v)}
          />
          <NumberField
            key={values.keepTailTurns}
            label="Keep tail turns"
            help="Minimum number of most-recent turns always kept verbatim. A floor — the tail-budget fraction below usually dominates in tool-heavy conversations."
            value={values.keepTailTurns}
            onCommit={(v) => set("keepTailTurns", Math.max(1, Math.round(v)))}
          />
          <Slider
            label="Tail budget fraction"
            help="Target size of the kept tail as a fraction of the effective budget."
            value={values.tailBudgetFraction} min={0} max={1} step={0.01}
            onChange={(v) => set("tailBudgetFraction", v)}
          />
        </div>

        <div className={CARD}>
          <div className={CARD_TITLE}>Protected tools</div>
          <label className="block text-[11px] text-white/80">
            <span className="mb-0.5 block font-semibold text-white/90">Unrecoverable tools</span>
            <span className="mb-1 block text-[10px] text-white/50">Comma or newline separated tool names whose calls/results are never cleared, summarized, or expelled — e.g. anything whose output can&apos;t be regenerated by re-running it.</span>
            <textarea
              defaultValue={values.unrecoverableTools}
              onBlur={(e) => set("unrecoverableTools", e.target.value)}
              rows={2}
              className={`${TEXT_INPUT} resize-y`}
            />
          </label>
        </div>
      </div>

      <div className="w-80 shrink-0">
        <CompactionBudgetIllustration
          assumedContextTokens={values.assumedContextTokens}
          clearThreshold={values.clearThreshold}
          summarizeThreshold={values.summarizeThreshold}
          hardLimit={values.hardLimit}
          blockSize={values.blockSize}
          maxRetainedBlocks={values.maxRetainedBlocks}
          keepTailTurns={values.keepTailTurns}
        />
      </div>
    </div>
  );
}
