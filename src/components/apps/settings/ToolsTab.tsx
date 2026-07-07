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
  deferred?: boolean;
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
// here rewrites what the LLM sees for that tool across every agent; toggling
// the "deferred" checkbox flips whether the tool is initially hidden (agents
// discover it via find_tools) or always visible. Both changes persist to
// data/tool-metadata-overrides.json and take effect on the next agent turn.
export function ToolsTab() {
  const [catalog, setCatalog] = useState<Capability[]>([]);
  // Description-only view (id → override description) kept alongside the full
  // metadataOverrides so ToolRow's textarea logic remains a plain string map
  // and the existing bos:tool-descriptions-updated event contract still works.
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [metadataOverrides, setMetadataOverrides] = useState<MetadataOverrides>({});
  const [maxFindResults, setMaxFindResults] = useState<number>(MAX_FIND_RESULTS_DEFAULT);

  const load = useCallback(async () => {
    try {
      const res = (await fetch("/api/tool-descriptions").then((r) => r.json())) as Payload;
      setCatalog(res.catalog ?? []);
      const meta = res.overrides ?? {};
      setMetadataOverrides(meta);
      setOverrides(descriptionMap(meta));
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

  const patchServer = useCallback(async (patch: { id: string; description?: string; deferred?: boolean | null }) => {
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
    setMetadataOverrides((prev) => {
      const next = { ...prev };
      const entry: MetadataOverride = { ...(next[patch.id] ?? {}) };
      if (patch.description) entry.description = patch.description;
      else delete entry.description;
      if (entry.description === undefined && entry.deferred === undefined) delete next[patch.id];
      else next[patch.id] = entry;
      return next;
    });
  }, [patchServer]);

  const save = useAutoSave<{ id: string; description: string }>(saveDescription);

  // Optimistic toggle. `deferred` is stored ONLY when it differs from the
  // registry default (see tool-metadata-overrides.setMetadataOverride) — the
  // server drops it otherwise and we mirror that in local state on reload.
  const toggleDeferred = useCallback(async (id: string, nextEffective: boolean) => {
    setMetadataOverrides((prev) => {
      const next = { ...prev };
      const entry: MetadataOverride = { ...(next[id] ?? {}) };
      entry.deferred = nextEffective;
      next[id] = entry;
      return next;
    });
    try {
      await patchServer({ id, deferred: nextEffective });
    } catch {
      // Roll back on failure by re-reading from the server.
      void load();
    }
  }, [patchServer, load]);

  const groups = useMemo(() => groupByCategory(catalog), [catalog]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-2">
        <p className="text-[11px] text-white/50">
          Rewrite what the LLM sees for any tool, or toggle whether it&apos;s hidden until discovered.
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
                {items.map((tool) => {
                  // Effective deferred = optimistic override in metadataOverrides
                  // (if the user just toggled) else the value the server returned
                  // in the catalog (already merged registry ⊕ persisted override).
                  const overrideDeferred = metadataOverrides[tool.id]?.deferred;
                  const effectiveDeferred = overrideDeferred ?? tool.deferred === true;
                  return (
                    <ToolRow
                      // Re-key on override presence so a reset (override cleared) or
                      // an incoming override remounts the row with the new initial
                      // draft — cleaner than syncing prop→state inside an effect.
                      key={`${tool.id}:${overrides[tool.id] ?? ""}`}
                      id={tool.id}
                      sourceDescription={tool.description}
                      override={overrides[tool.id]}
                      deferred={effectiveDeferred}
                      onSave={(description) => save.save({ id: tool.id, description })}
                      onToggleDeferred={(next) => void toggleDeferred(tool.id, next)}
                    />
                  );
                })}
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
  onToggleDeferred,
}: {
  id: string;
  sourceDescription: string;
  override: string | undefined;
  deferred: boolean;
  onSave: (description: string) => void;
  onToggleDeferred: (next: boolean) => void;
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
              title="Hidden from the agent's initial context — discovered at runtime via find_tools."
            >
              deferred
            </span>
          )}
          <label
            className="ml-1 flex shrink-0 cursor-pointer items-center gap-1 text-[10px] text-white/60 hover:text-white/80"
            title="Toggle whether this tool is hidden from the agent's initial context (discovered via find_tools)."
          >
            <input
              type="checkbox"
              checked={deferred}
              onChange={(e) => onToggleDeferred(e.target.checked)}
              className="h-3 w-3 accent-amber-400"
            />
            <span>deferred</span>
          </label>
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
