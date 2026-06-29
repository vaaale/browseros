"use client";

import { useCallback, useEffect, useState } from "react";

interface Ver {
  role: string;
  branch?: string;
  state: string;
  commit?: string;
  reused?: boolean;
}
interface SupState {
  base: Ver | null;
  preview: Ver | null;
  pushMode?: string;
  baseBranch?: string;
}

function VersionRow({ v }: { v: Ver | null }) {
  if (!v) return null;
  return (
    <div className="grid grid-cols-[90px_1fr] gap-x-3 text-white/60">
      <span className="capitalize">{v.role}</span>
      <span>
        {v.state}
        {v.branch ? ` · ${v.branch}` : ""}
        {v.reused ? " · (reused dev server)" : ""}
      </span>
    </div>
  );
}

// In-OS view of live version control. Mirrors the Supervisor's /__supervisor
// control surface; degrades to a hint when BrowserOS isn't served through it.
export function VersionsTab() {
  const [state, setState] = useState<SupState | null>(null);
  const [absent, setAbsent] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/__supervisor/state");
      if (!r.ok) return setAbsent(true);
      setState((await r.json()) as SupState);
      setAbsent(false);
    } catch {
      setAbsent(true);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const act = async (p: string, body?: Record<string, unknown>) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(`/__supervisor/${p}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const j = await r.json();
      if (j.pinned !== undefined) return window.location.reload();
      setMsg(j.ok === false ? `Error: ${j.error}` : "Done.");
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (absent) {
    return (
      <p className="text-xs text-white/50">
        The Supervisor isn’t running. Live version control is available when BrowserOS is served through it — start it with <code>npm run supervisor</code>.
      </p>
    );
  }
  if (!state) return <p className="text-xs text-white/40">Loading…</p>;

  const preview = state.preview;
  const ready = preview?.state === "ready";
  const btn = "rounded px-2 py-1 text-xs disabled:opacity-40";
  return (
    <div className="space-y-4 text-xs">
      <p className="text-white/50">
        Run a feature branch alongside base and promote safely. Base branch <code>{state.baseBranch}</code> · push mode <code>{state.pushMode}</code>.
      </p>
      <div className="space-y-1 rounded border border-white/10 bg-black/20 p-3">
        <VersionRow v={state.base} />
        <VersionRow v={state.preview} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button disabled={busy || !ready} onClick={() => act("pin", { version: "preview" })} className={`${btn} bg-violet-500/30 hover:bg-violet-500/45`}>Preview</button>
        <button disabled={busy} onClick={() => act("pin", { version: "base" })} className={`${btn} bg-white/10 hover:bg-white/20`}>Back to base</button>
        <button disabled={busy || !ready} onClick={() => act("promote")} className={`${btn} bg-emerald-500/25 hover:bg-emerald-500/40`}>Promote</button>
        <button disabled={busy || !preview} onClick={() => act("discard")} className={`${btn} bg-white/10 hover:bg-white/20`}>Stop</button>
        <button disabled={busy} onClick={() => act("push")} className={`${btn} bg-white/10 hover:bg-white/20`}>Push to remote</button>
        <button disabled={busy} onClick={() => load()} className={`${btn} bg-white/10 hover:bg-white/20`}>Refresh</button>
      </div>
      {msg && <span className="text-white/60">{msg}</span>}
    </div>
  );
}
