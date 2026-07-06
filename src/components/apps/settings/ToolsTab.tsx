"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AutoSaveStatus } from "./AutoSaveStatus";
import { useAutoSave } from "./hooks/useAutoSave";

interface Capability {
  id: string;
  group: string;
  description: string;
  context: "action" | "tool" | "both";
}

interface Payload {
  catalog: Capability[];
  overrides: Record<string, string>;
}

// Settings → Tools: global tool-description overrides. Editing a description
// here rewrites what the LLM sees for that tool across every agent (both
// server-side sub-agent tools and client-side actions). Save on blur; empty
// description restores the source (registry) copy.
export function ToolsTab() {
  const [catalog, setCatalog] = useState<Capability[]>([]);
  const [overrides, setOverrides] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const res = (await fetch("/api/tool-descriptions").then((r) => r.json())) as Payload;
      setCatalog(res.catalog ?? []);
      setOverrides(res.overrides ?? {});
    } catch { /* keep previous state */ }
  }, []);

  useEffect(() => {
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);

  const savePatch = useCallback(async (patch: { id: string; description: string }) => {
    const res = await fetch("/api/tool-descriptions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error || `Failed to save description (${res.status})`);
    }
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("bos:tool-descriptions-updated"));
    }
    setOverrides((prev) => {
      const next = { ...prev };
      if (patch.description) next[patch.id] = patch.description;
      else delete next[patch.id];
      return next;
    });
  }, []);

  const save = useAutoSave<{ id: string; description: string }>(savePatch);

  const groups = useMemo(() => groupByCategory(catalog), [catalog]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-2">
        <p className="text-[11px] text-white/50">
          Rewrite what the LLM sees for any tool. Leave a description empty to restore the source copy.
        </p>
        <AutoSaveStatus status={save.status} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
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

function ToolRow({
  id,
  sourceDescription,
  override,
  onSave,
}: {
  id: string;
  sourceDescription: string;
  override: string | undefined;
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
        <span className="min-w-0 truncate font-mono text-[11px] text-white">{id}</span>
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
