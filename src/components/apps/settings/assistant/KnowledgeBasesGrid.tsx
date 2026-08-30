"use client";

import type { CatalogKb } from "./types";

export interface KnowledgeBasesGridProps {
  all: CatalogKb[];
  /** The agent's current KB allowlist (038-knowledge-base). An empty array
   *  means "all allowed", mirroring SkillsGrid — the UI renders every
   *  checkbox as checked. */
  allowed: string[];
  onChange: (nextAllowed: string[]) => void;
}

/**
 * Grid of knowledge-base cards (checkbox + name + description). Same
 * empty-allowlist semantics as SkillsGrid/McpGrid — an empty `allowed` renders
 * every KB as checked; unchecking one converts to an explicit allowlist of the
 * remaining KBs. This scopes the agent's kbs_tool_search/kbs_tool_retrieve.
 */
export function KnowledgeBasesGrid({ all, allowed, onChange }: KnowledgeBasesGridProps) {
  const isImplicitAll = allowed.length === 0;
  const allowedSet = new Set(allowed);

  const toggle = (id: string) => {
    const currentlyChecked = isImplicitAll || allowedSet.has(id);
    if (currentlyChecked) {
      const base = isImplicitAll ? all.map((kb) => kb.id) : allowed;
      onChange(base.filter((x) => x !== id));
    } else {
      onChange([...allowed, id]);
    }
  };

  if (all.length === 0) {
    return (
      <p className="rounded border border-white/10 bg-white/[0.02] px-3 py-2 text-[11px] text-white/40">
        No knowledge bases installed. Install the Knowledge Base app to create one.
      </p>
    );
  }

  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}>
      {all.map((kb) => {
        const checked = isImplicitAll || allowedSet.has(kb.id);
        return (
          <label
            key={kb.id}
            className="flex cursor-pointer flex-col items-start rounded-md border border-white/10 bg-white/5 p-2 transition-colors hover:border-white/20 hover:bg-white/10"
          >
            <div className="mb-1 flex w-full items-center">
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(kb.id)}
                className="mr-1.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-violet-500"
              />
              <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-white">
                {kb.name}
              </span>
            </div>
            <span className="block text-[10px] leading-snug text-white/50">
              {kb.description || "No description available"}
            </span>
          </label>
        );
      })}
    </div>
  );
}
