"use client";

import { useEffect, useMemo, useState } from "react";
import { getDangerousToolNames } from "@/lib/agent/capabilities-registry";
import { ToolGroupList, type GroupMeta } from "../tools/ToolGroupList";
import type { CatalogTool } from "./types";

export interface ToolAccordionsProps {
  all: CatalogTool[];
  /** The agent's current tool allowlist (Phase B strict: empty array → no
   *  tools). Every existing agent is backfilled with the full capability list
   *  by the migration so this is only empty when the user has explicitly
   *  cleared it. */
  allowed: string[];
  /** Tool ids the agent hides from its initial context. This is the only
   *  source of deferred-ness for the agent — there is no registry default. */
  deferred: string[];
  onChange: (nextAllowed: string[]) => void;
  onChangeDeferred: (nextDeferred: string[]) => void;
}

/**
 * Categorized tool picker: each group ({@link CatalogTool.group}) becomes a
 * card with "Toggle All" / "Clear All" affordances and a grid of `<allow
 * checkbox + monospace name + deferred checkbox>`. Dangerous tools (per
 * capabilities-registry) render their description in red with a ⚠️ prefix.
 *
 * The deferred column lets the user hide an allowed tool from THIS agent's
 * initial context; the agent will still be able to discover it via
 * `find_tools(query=…)`. Deferred is purely per-agent — there is no
 * registry-wide default, so leaving this unchecked means the tool is visible
 * from the start.
 *
 * Empty vs implicit-all (Phase B strict allowlist): the migration in the
 * subagents store guarantees every existing agent has an explicit tools list,
 * so an empty allowlist reaching this component means the user deliberately
 * cleared it and every checkbox renders unchecked (strict "no tools").
 */
export function ToolAccordions({ all, allowed, deferred, onChange, onChangeDeferred }: ToolAccordionsProps) {
  // 041-tool-groups: `CatalogTool.group` is a group ID now, so display names
  // come from the group catalog. Shares ToolGroupList with Settings → Tools —
  // this file used to carry its own copy of the grouping helper.
  const [groups, setGroups] = useState<GroupMeta[]>([]);
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/tool-groups")
      .then((r) => r.json())
      .then((res: { groups?: GroupMeta[] }) => {
        if (!cancelled) setGroups(res.groups ?? []);
      })
      .catch(() => { /* keep previous */ });
    return () => { cancelled = true; };
  }, []);
  const dangerous = useMemo(() => new Set(getDangerousToolNames()), []);

  const allowedSet = new Set(allowed);
  const deferredSet = new Set(deferred);
  const isChecked = (id: string) => allowedSet.has(id);
  const isDeferred = (id: string) => deferredSet.has(id);

  const toggleOne = (id: string) => {
    if (allowedSet.has(id)) onChange(allowed.filter((x) => x !== id));
    else onChange([...allowed, id]);
  };

  const toggleDeferred = (id: string) => {
    if (deferredSet.has(id)) onChangeDeferred(deferred.filter((x) => x !== id));
    else onChangeDeferred([...deferred, id]);
  };

  const toggleAllInGroup = (groupIds: string[]) => {
    const baseSet = new Set(allowed);
    const allOn = groupIds.every((id) => baseSet.has(id));
    if (allOn) {
      const remove = new Set(groupIds);
      onChange(allowed.filter((x) => !remove.has(x)));
    } else {
      // Add every group id that's not already present.
      const merged = [...allowed];
      for (const id of groupIds) if (!baseSet.has(id)) merged.push(id);
      onChange(merged);
    }
  };

  const clearGroup = (groupIds: string[]) => {
    const remove = new Set(groupIds);
    onChange(allowed.filter((x) => !remove.has(x)));
  };

  if (all.length === 0) {
    return (
      <p className="rounded border border-white/10 bg-white/[0.02] px-3 py-2 text-[11px] text-white/40">
        No tools registered.
      </p>
    );
  }

  return (
    <ToolGroupList
      items={all}
      groups={groups}
      emptyMessage="No tools available."
      renderHeaderActions={(items) => {
        const ids = items.map((c) => c.id);
        const allOn = ids.every((id) => isChecked(id));
        return (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => toggleAllInGroup(ids)}
              className="rounded px-1.5 py-0.5 text-[10px] text-white/50 transition-colors hover:bg-white/10 hover:text-white/80"
            >
              {allOn ? "Uncheck All" : "Toggle All"}
            </button>
            <button
              type="button"
              onClick={() => clearGroup(ids)}
              className="rounded px-1.5 py-0.5 text-[10px] text-white/50 transition-colors hover:bg-white/10 hover:text-white/80"
              title="Remove every tool in this group from the agent's allowlist"
            >
              Clear All
            </button>
          </div>
        );
      }}
      renderItems={(items) => (
        <div className="grid gap-1" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
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
                  <span className="min-w-0 flex-1 break-words font-mono text-[11px] text-white">{tool.id}</span>
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
                <span className={`mt-0.5 block text-[12px] leading-snug ${isDangerous ? "text-red-300" : "text-white/50"}`}>
                  {isDangerous ? "⚠️ " : ""}
                  {tool.description || "No description available"}
                </span>
              </div>
            );
          })}
        </div>
      )}
    />
  );
}
