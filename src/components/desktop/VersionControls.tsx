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
    const id = setInterval(load, 5000);
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
  const btn = "rounded px-1.5 py-0.5 transition-colors disabled:opacity-40";

  return (
    <div className="flex items-center gap-1 text-[11px]">
      {next?.state === "building" && <span className="text-amber-300/80">candidate building…</span>}
      {next?.state === "tests-failed" && <span className="text-red-300/80">tests failed</span>}
      {next?.state === "ready" && (
        <>
          <button disabled={busy} onClick={() => act("pin", { version: "next" })} className={`${btn} bg-violet-500/30 hover:bg-violet-500/45`}>Preview next</button>
          <button disabled={busy} onClick={() => act("promote")} className={`${btn} bg-emerald-500/25 hover:bg-emerald-500/40`}>Promote</button>
          <button disabled={busy} onClick={() => act("discard")} className={`${btn} bg-white/10 hover:bg-white/20`}>Discard</button>
        </>
      )}
      <button disabled={busy} onClick={() => act("pin", { version: "active" })} className={`${btn} bg-white/10 hover:bg-white/20`}>Active</button>
    </div>
  );
}
