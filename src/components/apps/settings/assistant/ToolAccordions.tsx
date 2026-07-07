"use client";

import { useMemo } from "react";
import { getDangerousToolNames } from "@/lib/agent/capabilities-registry";
import type { CatalogTool } from "./types";

export interface ToolAccordionsProps {
  all: CatalogTool[];
  /** The agent's current tool allowlist. Empty array → all allowed. */
  allowed: string[];
  /** Tool ids the agent hides from its initial context (additive over the
   *  registry defaults). */
  deferred: string[];
  onChange: (nextAllowed: string[]) => void;
  onChangeDeferred: (nextDeferred: string[]) => void;
}

/**
 * Categorized tool picker: each group ({@link CatalogTool.group}) becomes a
 * card with a "Toggle All" affordance and a grid of `<allow checkbox +
 * monospace name + deferred checkbox>`. Dangerous tools (per
 * capabilities-registry) render their description in red with a ⚠️ prefix.
 *
 * The deferred column lets the user hide an allowed tool from THIS agent's
 * initial context; the agent will still be able to discover it via
 * `find_tools(query=…)`. Per-agent deferred lists are additive over the
 * registry defaults — a tool that is deferred in the registry stays deferred
 * regardless of this toggle.
 */
export function ToolAccordions({ all, allowed, deferred, onChange, onChangeDeferred }: ToolAccordionsProps) {
  const groups = useMemo(() => groupByCategory(all), [all]);
  const dangerous = useMemo(() => new Set(getDangerousToolNames()), []);

  const isImplicitAll = allowed.length === 0;
  const allowedSet = new Set(allowed);
  const deferredSet = new Set(deferred);
  const isChecked = (id: string) => isImplicitAll || allowedSet.has(id);
  const isDeferred = (id: string) => deferredSet.has(id);

  // Any allowlist mutation must first materialize the implicit "all" state
  // into an explicit list — otherwise a single unchecked box would silently
  // stay allowed on the next render.
  const explicitBase = (): string[] => (isImplicitAll ? all.map((c) => c.id) : allowed);

  const toggleOne = (id: string) => {
    const base = explicitBase();
    if (base.includes(id)) onChange(base.filter((x) => x !== id));
    else onChange([...base, id]);
  };

  const toggleDeferred = (id: string) => {
    if (deferredSet.has(id)) onChangeDeferred(deferred.filter((x) => x !== id));
    else onChangeDeferred([...deferred, id]);
  };

  const toggleAllInGroup = (groupIds: string[]) => {
    const base = explicitBase();
    const baseSet = new Set(base);
    const allOn = groupIds.every((id) => baseSet.has(id));
    if (allOn) {
      const remove = new Set(groupIds);
      onChange(base.filter((x) => !remove.has(x)));
    } else {
      // Add every group id that's not already present.
      const merged = [...base];
      for (const id of groupIds) if (!baseSet.has(id)) merged.push(id);
      onChange(merged);
    }
  };

  if (all.length === 0) {
    return (
      <p className="rounded border border-white/10 bg-white/[0.02] px-3 py-2 text-[11px] text-white/40">
        No tools registered.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {groups.map(({ group, items }) => {
        const ids = items.map((c) => c.id);
        const allOn = ids.every((id) => isChecked(id));
        return (
          <div
            key={group}
            className="rounded-md border border-white/10 bg-white/[0.03] p-2.5"
          >
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-violet-300">
                {group}
              </span>
              <button
                type="button"
                onClick={() => toggleAllInGroup(ids)}
                className="rounded px-1.5 py-0.5 text-[10px] text-white/50 transition-colors hover:bg-white/10 hover:text-white/80"
              >
                {allOn ? "Uncheck All" : "Toggle All"}
              </button>
            </div>
            <div className="grid gap-1" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}>
              {items.map((tool) => {
                const checked = isChecked(tool.id);
                const deferredChecked = isDeferred(tool.id);
                const isDangerous = dangerous.has(tool.id);
                return (
                  <div
                    key={tool.id}
                    className="flex flex-col rounded border border-white/10 bg-white/[0.02] px-1.5 py-1 transition-colors hover:border-white/20 hover:bg-white/10"
                  >
                    <div className="flex w-full items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleOne(tool.id)}
                        className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-violet-500"
                        title="Allow this agent to use this tool"
                      />
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-white">
                        {tool.id}
                      </span>
                      <label
                        className="flex shrink-0 cursor-pointer items-center gap-1 text-[9px] uppercase tracking-wide text-white/50 hover:text-white/80"
                        title="Hide this tool from the agent's initial context (still discoverable via find_tools)"
                      >
                        <input
                          type="checkbox"
                          checked={deferredChecked}
                          onChange={() => toggleDeferred(tool.id)}
                          className="h-3 w-3 shrink-0 cursor-pointer accent-amber-400"
                        />
                        <span>deferred</span>
                      </label>
                    </div>
                    <span
                      className={`mt-0.5 block text-[10px] leading-snug ${
                        isDangerous ? "text-red-300" : "text-white/50"
                      }`}
                    >
                      {isDangerous ? "⚠️ " : ""}
                      {tool.description || "No description available"}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface Grouped {
  group: string;
  items: CatalogTool[];
}

// Group tools by their `.group` field, preserving first-seen order so the
// registry's own ordering (OS → Files → Web → …) drives layout without a
// separate sort table. Empty groups collapse into "General" per spec.
function groupByCategory(tools: CatalogTool[]): Grouped[] {
  const order: string[] = [];
  const buckets = new Map<string, CatalogTool[]>();
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
