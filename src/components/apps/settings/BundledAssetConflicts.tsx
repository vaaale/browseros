"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import type { BundledAssetConflict, BundledAssetKind } from "@/system/marketplace/install/bundledAssets";

// Keep-vs-replace prompt for a bundled agent/skill that a marketplace item
// wants to update, but which was edited locally since it was installed
// (040-okf-knowledge-base). The update is NEVER applied silently in that case —
// the local copy stays until the user decides here.
//
// Rendered inside the Agents and Skills tabs (filtered by kind) rather than in a
// tab of its own: the decision is about a specific agent/skill, so it belongs
// where the user already manages them.

export function BundledAssetConflicts({ kind, onResolved }: { kind: BundledAssetKind; onResolved?: () => void }) {
  const [conflicts, setConflicts] = useState<BundledAssetConflict[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/bundled-assets").then((r) => r.json());
      setConflicts((res.conflicts ?? []).filter((c: BundledAssetConflict) => c.kind === kind));
    } catch {
      setConflicts([]);
    }
  }, [kind]);

  useEffect(() => {
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);

  const resolve = useCallback(
    async (conflict: BundledAssetConflict, resolution: "keep" | "replace") => {
      setBusy(conflict.id);
      try {
        await fetch("/api/bundled-assets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: conflict.kind, id: conflict.id, resolution }),
        });
        await load();
        onResolved?.();
      } finally {
        setBusy(null);
      }
    },
    [load, onResolved],
  );

  if (conflicts.length === 0) return null;

  const noun = kind === "agent" ? "agent" : "skill";

  return (
    <div className="space-y-2">
      {conflicts.map((c) => (
        <div key={`${c.kind}:${c.id}`} className="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
          <div className="flex items-start gap-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-400" />
            <div className="min-w-0 flex-1 space-y-2">
              <div>
                <p className="font-medium text-amber-200">
                  &ldquo;{c.id}&rdquo; has a newer version from {c.itemId}
                </p>
                <p className="mt-1 text-white/60">
                  {c.reason === "diverged"
                    ? `This ${noun} was edited since it was installed, so the update wasn't applied automatically.`
                    : `This ${noun} already existed and BOS can't tell whether it was edited, so the update wasn't applied automatically.`}{" "}
                  Your current version is still in use.
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  disabled={busy === c.id}
                  onClick={() => void resolve(c, "keep")}
                  className="rounded bg-white/10 px-2.5 py-1 text-[11px] hover:bg-white/20 disabled:opacity-50"
                >
                  Keep mine
                </button>
                <button
                  disabled={busy === c.id}
                  onClick={() => void resolve(c, "replace")}
                  className="rounded bg-amber-500/80 px-2.5 py-1 text-[11px] text-black hover:bg-amber-500 disabled:opacity-50"
                >
                  Use the update
                </button>
              </div>
              <p className="text-white/40">
                &ldquo;Use the update&rdquo; overwrites your version and can&rsquo;t be undone.
              </p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
