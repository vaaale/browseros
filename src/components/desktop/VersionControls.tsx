"use client";

import { useCallback, useEffect, useState } from "react";

interface Ver {
  role: string;
  branch?: string;
  state: string;
}
interface SupState {
  active: Ver | null;
  next: Ver | null;
  previous: Ver | null;
}

// Compact live-version-control surface in the Topbar. Renders nothing unless
// BrowserOS is served through the Supervisor (so /__supervisor/state resolves).
// Versions are labelled by their git branch (resolved live by the Supervisor),
// and the candidate appears as soon as its worktree exists — i.e. the moment
// the agent starts developing — not only once it has built.
export function VersionControls() {
  const [state, setState] = useState<SupState | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/__supervisor/state");
      if (!r.ok) return setState(null);
      setState((await r.json()) as SupState);
    } catch {
      setState(null);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const id = setInterval(load, 2500);
    return () => clearInterval(id);
  }, [load]);

  const act = async (p: string, body?: Record<string, unknown>) => {
    setBusy(true);
    try {
      const r = await fetch(`/__supervisor/${p}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const j = await r.json();
      if (j.pinned !== undefined) return window.location.reload();
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (!state) return null;
  const next = state.next;
  const activeLabel = state.active?.branch || "active";
  const ready = next?.state === "ready";
  const failed = next?.state === "failed" || next?.state === "tests-failed";
  const btn = "rounded px-1.5 py-0.5 transition-colors disabled:opacity-40 disabled:cursor-default";

  return (
    <div className="flex items-center gap-1 text-[11px]">
      {next && (
        <>
          <span className="text-white/55" title={`candidate branch: ${next.branch ?? "(unknown)"}`}>{next.branch ?? "candidate"}</span>
          {next.state === "idle" && <span className="text-amber-300/80">developing…</span>}
          {next.state === "building" && <span className="text-amber-300/80">building…</span>}
          {failed && <span className="text-red-300/80">build failed</span>}
          <button disabled={busy || !ready} onClick={() => act("pin", { version: "next" })} className={`${btn} bg-violet-500/30 hover:bg-violet-500/45`}>Preview</button>
          <button disabled={busy || !ready} onClick={() => act("promote")} className={`${btn} bg-emerald-500/25 hover:bg-emerald-500/40`}>Promote</button>
          <button disabled={busy || !(ready || failed)} onClick={() => act("discard")} className={`${btn} bg-white/10 hover:bg-white/20`}>Discard</button>
          <span className="mx-0.5 text-white/20">|</span>
        </>
      )}
      <button disabled={busy} onClick={() => act("pin", { version: "active" })} className={`${btn} bg-white/10 hover:bg-white/20`} title="Back to the active version">{activeLabel}</button>
    </div>
  );
}
