"use client";

// 045 T020 — assign a method to a spec store, an item store, or a single
// Project (FR-008, FR-009, FR-010).
//
// Sits on the store-group header beside the existing owner/writable badges, and
// on a Project row. NOT rendered for a read-only store: bos-system-specs is
// permanently spec-kit, so offering a dropdown there would advertise a choice
// that cannot be made.
//
// `current` comes from the TREE NODE, not from one app-level "active method".
// The binding chain is project > store > global default, so two groups in one
// tree legitimately differ; a single shared value rendered every picker with
// user-specs' method regardless of what the store was actually bound to.

import { useCallback, useEffect, useState } from "react";
import type { MethodSummary } from "@/lib/specs/method/types";

interface PreflightResponse {
  report?: { wouldOrphan: boolean; orphaned: string[]; orphanedOnBranch: string[]; gained: string[] };
  summary?: string;
  constitution?: string;
  error?: string;
}

export function MethodPicker({
  storeId,
  projectId,
  current,
  inherited,
  writable,
  branch,
  onChanged,
}: {
  storeId: string;
  /** Bind this Project rather than the whole store. */
  projectId?: string;
  current?: string;
  /** True when `current` is inherited rather than declared at this level. */
  inherited?: boolean;
  writable: boolean;
  branch?: string;
  onChanged: () => void;
}) {
  const [methods, setMethods] = useState<MethodSummary[]>([]);
  const [pending, setPending] = useState<string>("");
  const [preview, setPreview] = useState<PreflightResponse | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!writable) return;
    fetch("/api/methods")
      .then((r) => r.json())
      .then((d) => setMethods(d.methods ?? []))
      .catch(() => setMethods([]));
  }, [writable]);

  const propose = useCallback(
    async (methodId: string) => {
      // Compare against the RESOLVED current value. An inherited binding is
      // still the value in force, so re-picking it is genuinely a no-op —
      // except that at Project scope it would PIN the inheritance, which is a
      // real change and is allowed through below.
      if (!methodId || (methodId === current && !inherited)) return;
      setBusy(true);
      try {
        const r = await fetch("/api/specs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ op: "preflight-method", store: storeId, project: projectId, method: methodId }),
        });
        setPending(methodId);
        setPreview((await r.json()) as PreflightResponse);
      } finally {
        setBusy(false);
      }
    },
    [current, inherited, projectId, storeId],
  );

  const confirm = useCallback(
    async (force: boolean) => {
      setBusy(true);
      try {
        const r = await fetch("/api/specs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ op: "set-method", store: storeId, project: projectId, method: pending, branch, force }),
        });
        const d = (await r.json()) as { error?: string };
        if (!r.ok) {
          setPreview({ error: d.error });
          return;
        }
        setPreview(null);
        setPending("");
        onChanged();
      } finally {
        setBusy(false);
      }
    },
    [branch, onChanged, pending, projectId, storeId],
  );

  // A read-only store has no choice to offer. Rendering a disabled control
  // would imply the binding is changeable and merely blocked right now.
  if (!writable || methods.length <= 1) return null;

  const orphans = (preview?.report?.orphaned.length ?? 0) + (preview?.report?.orphanedOnBranch.length ?? 0);

  return (
    <>
      <select
        value={current ?? "spec-kit"}
        disabled={busy}
        onChange={(e) => void propose(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        className={`rounded border border-white/10 px-1 py-0.5 text-[10px] ${
          inherited ? "bg-transparent text-white/40 italic" : "bg-white/5 text-white/70"
        }`}
        title={
          projectId
            ? inherited
              ? `Inherited from ${storeId}. Choosing a method here binds THIS project only.`
              : `Spec method for the "${projectId}" project only`
            : inherited
              ? "Inherited from your default method — choosing one here binds this store."
              : "Spec method for this store"
        }
      >
        {methods.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
            {m.builtin ? " (built in)" : ""}
          </option>
        ))}
      </select>

      {preview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="max-h-[70vh] w-[32rem] overflow-auto rounded-lg border border-white/10 bg-neutral-900 p-4 text-xs">
            <div className="mb-2 text-sm font-medium text-white/90">
              Switch {projectId ? `${storeId}/${projectId}` : storeId} to {pending}?
            </div>
            {projectId && (
              <p className="mb-2 text-white/40">
                Binds this project only — the rest of {storeId} keeps its own method.
              </p>
            )}
            {preview.error ? (
              <pre className="whitespace-pre-wrap text-rose-300">{preview.error}</pre>
            ) : (
              <>
                <pre className="whitespace-pre-wrap text-white/70">{preview.summary}</pre>
                {preview.constitution && <p className="mt-2 text-white/50">{preview.constitution}</p>}
              </>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                className="rounded border border-white/10 px-2 py-1 text-white/70"
                onClick={() => {
                  setPreview(null);
                  setPending("");
                }}
              >
                Cancel
              </button>
              {/* Preflight is the GATE. When it says content would be hidden,
                  the plain confirm is NOT offered — the only way through is an
                  explicit override that names what it overrides. */}
              {orphans > 0 ? (
                <button
                  className="rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-rose-200"
                  disabled={busy}
                  onClick={() => void confirm(true)}
                >
                  Hide {orphans} unit(s) and switch anyway
                </button>
              ) : (
                <button
                  className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-emerald-200"
                  disabled={busy}
                  onClick={() => void confirm(false)}
                >
                  Switch
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
