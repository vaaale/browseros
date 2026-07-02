"use client";

import type { CatalogMcp } from "./types";

export interface McpGridProps {
  all: CatalogMcp[];
  /** The agent's current MCP-server allowlist. Empty array → all allowed. */
  allowed: string[];
  onChange: (nextAllowed: string[]) => void;
}

/**
 * Grid of MCP-server cards (checkbox + name + description). Same
 * empty-allowlist semantics as SkillsGrid — an empty `allowed` renders every
 * server as checked.
 */
export function McpGrid({ all, allowed, onChange }: McpGridProps) {
  const isImplicitAll = allowed.length === 0;
  const allowedSet = new Set(allowed);

  const toggle = (name: string) => {
    const currentlyChecked = isImplicitAll || allowedSet.has(name);
    if (currentlyChecked) {
      const base = isImplicitAll ? all.map((s) => s.name) : allowed;
      onChange(base.filter((x) => x !== name));
    } else {
      onChange([...allowed, name]);
    }
  };

  if (all.length === 0) {
    return (
      <p className="rounded border border-white/10 bg-white/[0.02] px-3 py-2 text-[11px] text-white/40">
        No MCP servers configured.
      </p>
    );
  }

  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}>
      {all.map((server) => {
        const checked = isImplicitAll || allowedSet.has(server.name);
        return (
          <label
            key={server.name}
            className="flex cursor-pointer flex-col items-start rounded-md border border-white/10 bg-white/5 p-2 transition-colors hover:border-white/20 hover:bg-white/10"
          >
            <div className="mb-1 flex w-full items-center">
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(server.name)}
                className="mr-1.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-violet-500"
              />
              <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-white">
                {server.name}
              </span>
            </div>
            <span className="block text-[10px] leading-snug text-white/50">
              {server.description || server.endpoint || "No description available"}
            </span>
          </label>
        );
      })}
    </div>
  );
}
