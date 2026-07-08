"use client";

import type { CatalogSkill } from "./types";

export interface SkillsGridProps {
  all: CatalogSkill[];
  /** The agent's current allowlist. An empty array means "all allowed" for
   *  back-compat (FR-008); the UI renders every checkbox as checked. */
  allowed: string[];
  onChange: (nextAllowed: string[]) => void;
}

/**
 * Grid of skill cards (checkbox + name + description). Empty-allowlist
 * semantics: when `allowed` is empty every skill is displayed as checked;
 * unchecking one converts to an explicit allowlist of the remaining skills.
 */
export function SkillsGrid({ all, allowed, onChange }: SkillsGridProps) {
  const isImplicitAll = allowed.length === 0;
  const allowedSet = new Set(allowed);

  const toggle = (id: string) => {
    const currentlyChecked = isImplicitAll || allowedSet.has(id);
    if (currentlyChecked) {
      // Collapse implicit "all" into an explicit list first so unchecking is
      // observable server-side; otherwise remove from the explicit list.
      const base = isImplicitAll ? all.map((s) => s.id) : allowed;
      onChange(base.filter((x) => x !== id));
    } else {
      onChange([...allowed, id]);
    }
  };

  if (all.length === 0) {
    return (
      <p className="rounded border border-white/10 bg-white/[0.02] px-3 py-2 text-[11px] text-white/40">
        No skills registered.
      </p>
    );
  }

  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}>
      {all.map((skill) => {
        const checked = isImplicitAll || allowedSet.has(skill.id);
        return (
          <label
            key={skill.id}
            className="flex cursor-pointer flex-col items-start rounded-md border border-white/10 bg-white/5 p-2 transition-colors hover:border-white/20 hover:bg-white/10"
          >
            <div className="mb-1 flex w-full items-center">
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(skill.id)}
                className="mr-1.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-violet-500"
              />
              <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-white">
                {skill.name}
              </span>
            </div>
            <span className="block text-[10px] leading-snug text-white/50">
              {skill.description || "No description available"}
            </span>
          </label>
        );
      })}
    </div>
  );
}
