"use client";

import { SCOPE_CLASS_META, type ScopeClass } from "@/lib/self-heal/types";

// The scope-class badge (031-self-healing, mockup.html §4 — a BINDING visual
// decision per design §8): six distinct hues, one per class, reused verbatim in
// the case list, the case detail header and the legend, so the badge is
// recognizably the same object everywhere.

const TONE: Record<ScopeClass, string> = {
  a: "border-white/15 bg-white/10 text-white/60",
  b: "border-violet-500/30 bg-violet-500/15 text-violet-300",
  c: "border-blue-500/30 bg-blue-500/15 text-blue-300",
  d: "border-amber-500/30 bg-amber-500/15 text-amber-300",
  "d-bis": "border-pink-500/30 bg-pink-500/15 text-pink-300",
  e: "border-emerald-500/30 bg-emerald-500/15 text-emerald-300",
};

const BASE = "inline-block shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold";

export function ScopeClassBadge({ scopeClass, showOwnership = true }: { scopeClass?: ScopeClass; showOwnership?: boolean }) {
  if (!scopeClass) {
    return <span className={`${BASE} border-white/10 bg-white/5 text-white/35`}>undiagnosed</span>;
  }
  const meta = SCOPE_CLASS_META[scopeClass];
  return (
    <span className={`${BASE} ${TONE[scopeClass]}`} data-testid={`scope-badge-${scopeClass}`} title={`${meta.label} — ${meta.kind}`}>
      {scopeClass}
      {showOwnership ? ` · ${meta.ownership}` : ""}
    </span>
  );
}

/** The legend (mockup §4). Rendered under the case list so the vocabulary is
 *  learnable in place rather than only in the docs. */
export function ScopeClassLegend() {
  return (
    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3" data-testid="scope-class-legend">
      {(Object.keys(SCOPE_CLASS_META) as ScopeClass[]).map((sc) => {
        const meta = SCOPE_CLASS_META[sc];
        return (
          <div key={sc} className="flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-1.5">
            <ScopeClassBadge scopeClass={sc} showOwnership={false} />
            <div className="min-w-0">
              <div className="truncate text-[11px] font-semibold text-white/85">{meta.label}</div>
              <div className="truncate text-[10px] text-white/40">{meta.kind}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
