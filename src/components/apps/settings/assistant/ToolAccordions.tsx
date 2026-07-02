"use client";

import { useMemo } from "react";
import { getDangerousToolNames } from "@/lib/agent/capabilities-registry";
import type { CatalogTool } from "./types";

export interface ToolAccordionsProps {
  all: CatalogTool[];
  /** The agent's current tool allowlist. Empty array → all allowed. */
  allowed: string[];
  onChange: (nextAllowed: string[]) => void;
}

/**
 * Categorized tool picker: each group ({@link CatalogTool.group}) becomes a
 * card with a "Toggle All" affordance and a grid of `<checkbox + monospace
 * name + description>`. Dangerous tools (per capabilities-registry) render
 * their description in red with a ⚠️ prefix.
 */
export function ToolAccordions({ all, allowed, onChange }: ToolAccordionsProps) {
  const groups = useMemo(() => groupByCategory(all), [all]);
  const dangerous = useMemo(() => new Set(getDangerousToolNames()), []);

  const isImplicitAll = allowed.length === 0;
  const allowedSet = new Set(allowed);
  const isChecked = (id: string) => isImplicitAll || allowedSet.has(id);

  // Any allowlist mutation must first materialize the implicit "all" state
  // into an explicit list — otherwise a single unchecked box would silently
  // stay allowed on the next render.
  const explicitBase = (): string[] => (isImplicitAll ? all.map((c) => c.id) : allowed);

  const toggleOne = (id: string) => {
    const base = explicitBase();
    if (base.includes(id)) onChange(base.filter((x) => x !== id));
    else onChange([...base, id]);
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
            <div className="grid gap-1" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))" }}>
              {items.map((tool) => {
                const checked = isChecked(tool.id);
                const isDangerous = dangerous.has(tool.id);
                return (
                  <label
                    key={tool.id}
                    className="flex cursor-pointer flex-col items-start rounded border border-white/10 bg-white/[0.02] px-1.5 py-1 transition-colors hover:border-white/20 hover:bg-white/10"
                  >
                    <div className="flex w-full items-center">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleOne(tool.id)}
                        className="mr-1.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-violet-500"
                      />
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-white">
                        {tool.id}
                      </span>
                    </div>
                    <span
                      className={`mt-0.5 block text-[10px] leading-snug ${
                        isDangerous ? "text-red-300" : "text-white/50"
                      }`}
                    >
                      {isDangerous ? "⚠️ " : ""}
                      {tool.description || "No description available"}
                    </span>
                  </label>
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
