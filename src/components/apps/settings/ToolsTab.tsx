"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AutoSaveStatus } from "./AutoSaveStatus";
import { useAutoSave } from "./hooks/useAutoSave";

interface Capability {
  id: string;
  group: string;
  description: string;
  context: "action" | "tool" | "both";
  deferred?: boolean;
}

interface MetadataOverride {
  description?: string;
}

type MetadataOverrides = Record<string, MetadataOverride>;

interface Payload {
  catalog: Capability[];
  overrides: MetadataOverrides;
}

const MAX_FIND_RESULTS_MIN = 5;
const MAX_FIND_RESULTS_MAX = 25;
const MAX_FIND_RESULTS_DEFAULT = 10;

function clampMaxFindResults(n: number): number {
  if (!Number.isFinite(n)) return MAX_FIND_RESULTS_DEFAULT;
  return Math.max(MAX_FIND_RESULTS_MIN, Math.min(MAX_FIND_RESULTS_MAX, Math.round(n)));
}

// Settings → Tools: global per-tool metadata overrides. Editing a description
// here rewrites what the LLM sees for that tool across every agent. The
// "deferred" badge is read-only and reflects the registry default — per-agent
// deferred visibility is edited in Settings → Agents → [agent] → Tools, since
// it is per-agent state.
export function ToolsTab() {
  const [catalog, setCatalog] = useState<Capability[]>([]);
  // Description-only view (id → override description). The
  // bos:tool-descriptions-updated event contract still fires when a description
  // is saved so other panels (e.g. ToolManifest) can refresh.
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [maxFindResults, setMaxFindResults] = useState<number>(MAX_FIND_RESULTS_DEFAULT);

  const load = useCallback(async () => {
    try {
      const res = (await fetch("/api/tool-descriptions").then((r) => r.json())) as Payload;
      setCatalog(res.catalog ?? []);
      setOverrides(descriptionMap(res.overrides ?? {}));
    } catch { /* keep previous state */ }
    try {
      const res = (await fetch("/api/config").then((r) => r.json())) as {
        schemas?: { namespace: string; values?: Record<string, unknown> }[];
      };
      const tools = (res.schemas ?? []).find((s) => s.namespace === "tools");
      const v = tools?.values?.maxFindResults;
      if (typeof v === "number" && Number.isFinite(v)) setMaxFindResults(clampMaxFindResults(v));
    } catch { /* keep previous value */ }
  }, []);

  useEffect(() => {
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);

  const saveMaxFindResults = useCallback(async (value: number) => {
    const clamped = clampMaxFindResults(value);
    setMaxFindResults(clamped);
    try {
      await fetch("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ namespace: "tools", values: { maxFindResults: clamped } }),
      });
    } catch { /* silently keep local state */ }
  }, []);

  const patchServer = useCallback(async (patch: { id: string; description: string }) => {
    const res = await fetch("/api/tool-descriptions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error || `Failed to save (${res.status})`);
    }
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("bos:tool-descriptions-updated"));
    }
  }, []);

  const saveDescription = useCallback(async (patch: { id: string; description: string }) => {
    await patchServer(patch);
    setOverrides((prev) => {
      const next = { ...prev };
      if (patch.description) next[patch.id] = patch.description;
      else delete next[patch.id];
      return next;
    });
  }, [patchServer]);

  const save = useAutoSave<{ id: string; description: string }>(saveDescription);

  const groups = useMemo(() => groupByCategory(catalog), [catalog]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-2">
        <p className="text-[11px] text-white/50">
          Rewrite what the LLM sees for any tool. Per-agent deferred visibility is edited in Settings → Agents.
        </p>
        <AutoSaveStatus status={save.status} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mb-3 rounded-md border border-white/10 bg-white/[0.03] p-2.5">
          <label className="flex items-center gap-2 text-[11px] text-white/80">
            <span className="min-w-0 flex-1">
              <span className="font-semibold text-white/90">Max discovery results</span>
              <span className="block text-[10px] text-white/50">
                Caps results returned by <span className="font-mono">find_tools</span> /{" "}
                <span className="font-mono">find_agent</span>. Range {MAX_FIND_RESULTS_MIN}–{MAX_FIND_RESULTS_MAX}, default {MAX_FIND_RESULTS_DEFAULT}.
              </span>
            </span>
            <input
              type="number"
              min={MAX_FIND_RESULTS_MIN}
              max={MAX_FIND_RESULTS_MAX}
              value={maxFindResults}
              onChange={(e) => setMaxFindResults(Number(e.target.value))}
              onBlur={(e) => void saveMaxFindResults(Number(e.target.value))}
              className="w-20 rounded border border-white/10 bg-black/30 px-2 py-1 text-right text-[11px] text-white outline-none focus:border-white/30"
            />
          </label>
        </div>
        <div className="flex flex-col gap-2">
          {groups.map(({ group, items }) => (
            <div key={group} className="rounded-md border border-white/10 bg-white/[0.03] p-2.5">
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-violet-300">
                {group}
              </div>
              <div className="flex flex-col gap-2">
                {items.map((tool) => (
                  <ToolRow
                    // Re-key on override presence so a reset (override cleared) or
                    // an incoming override remounts the row with the new initial
                    // draft — cleaner than syncing prop→state inside an effect.
                    key={`${tool.id}:${overrides[tool.id] ?? ""}`}
                    id={tool.id}
                    sourceDescription={tool.description}
                    override={overrides[tool.id]}
                    deferred={tool.deferred === true}
                    onSave={(description) => save.save({ id: tool.id, description })}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
        {catalog.length === 0 && <p className="text-xs text-white/40">Loading…</p>}
      </div>
    </div>
  );
}

function descriptionMap(overrides: MetadataOverrides): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, o] of Object.entries(overrides)) {
    if (typeof o.description === "string" && o.description.length > 0) out[id] = o.description;
  }
  return out;
}

function ToolRow({
  id,
  sourceDescription,
  override,
  deferred,
  onSave,
}: {
  id: string;
  sourceDescription: string;
  override: string | undefined;
  deferred: boolean;
  onSave: (description: string) => void;
}) {
  // Draft = current effective value shown to the user. Blur commits. The
  // parent remounts this row on override changes (via key prop) so we don't
  // need to sync prop→state inside an effect.
  const initial = override ?? sourceDescription;
  const [draft, setDraft] = useState(initial);

  const isOverridden = override !== undefined;

  const commit = (value: string) => {
    if (value === initial) return;
    // Empty string clears — server treats it as "reset to source".
    onSave(value.trim() === "" ? "" : value);
  };

  const reset = () => {
    setDraft(sourceDescription);
    onSave("");
  };

  return (
    <div className="rounded border border-white/10 bg-white/[0.02] p-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate font-mono text-[11px] text-white">{id}</span>
          {deferred && (
            <span
              className="shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-1 py-[1px] text-[9px] font-medium uppercase tracking-wide text-amber-300"
              title="Hidden from every agent's initial context by default — discovered at runtime via find_tools. Per-agent overrides live in Settings → Agents."
            >
              deferred
            </span>
          )}
        </div>
        {isOverridden && (
          <button
            type="button"
            onClick={reset}
            className="rounded px-1.5 py-0.5 text-[10px] text-white/50 transition-colors hover:bg-white/10 hover:text-white/80"
          >
            Reset
          </button>
        )}
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit(draft)}
        className="w-full resize-y rounded border border-white/10 bg-black/30 px-2 py-1.5 text-[11px] leading-relaxed text-white outline-none transition-colors focus:border-white/30"
        style={{ minHeight: "56px" }}
      />
      {isOverridden && (
        <div className="mt-1 text-[10px] leading-snug text-white/40">
          Source: <span className="text-white/50">{sourceDescription}</span>
        </div>
      )}
    </div>
  );
}

interface Grouped {
  group: string;
  items: Capability[];
}

function groupByCategory(tools: Capability[]): Grouped[] {
  const order: string[] = [];
  const buckets = new Map<string, Capability[]>();
  for (const t of tools) {
    const g = t.group?.trim() || "General";
    if (!buckets.has(g)) {
      buckets.set(g, []);
      order.push(g);
    }
    buckets.get(g)!.push(t);
  }
  return order.map((group) => ({ group, items: buckets.get(group)! }));
}
