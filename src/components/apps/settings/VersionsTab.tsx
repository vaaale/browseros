"use client";

import { useCallback, useEffect, useState } from "react";
import { sessionHeader } from "@/lib/logging/client/session";

interface Ver {
  role: string;
  branch?: string;
  state: string;
  commit?: string;
  reused?: boolean;
  buildError?: string;
}
interface SupState {
  base: Ver | null;
  previews: Ver[];
  pushMode?: string;
  baseBranch?: string;
  serving?: { role: string; branch?: string } | null;
}
interface Branches {
  branches: string[];
  base: string;
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
        {v.buildError ? <span className="mt-1 block whitespace-pre-wrap text-red-300/80">{v.buildError}</span> : null}
      </span>
    </div>
  );
}

export function VersionsTab() {
  const [state, setState] = useState<SupState | null>(null);
  const [branches, setBranches] = useState<Branches | null>(null);
  const [selectedBranch, setSelectedBranch] = useState("");
  const [absent, setAbsent] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [stateRes, branchRes] = await Promise.all([
        fetch("/__supervisor/state"),
        fetch("/__supervisor/branches"),
      ]);
      if (!stateRes.ok || !branchRes.ok) return setAbsent(true);
      const nextState = (await stateRes.json()) as SupState;
      const nextBranches = (await branchRes.json()) as Branches;
      setState(nextState);
      setBranches(nextBranches);
      setSelectedBranch((current) => current || nextState.serving?.branch || nextBranches.base);
      setAbsent(false);
    } catch {
      setAbsent(true);
    }
  }, []);

  useEffect(() => {
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);

  const act = async (path: string, body?: Record<string, unknown>) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(`/__supervisor/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionHeader() },
        body: JSON.stringify(body ?? {}),
      });
      const j = await r.json();
      setMsg(j.ok === false ? `Error: ${j.error}` : "Done.");
      if (j.ok !== false && (path === "pin" || path === "stop" || path === "discard" || path === "promote")) window.location.reload();
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (absent) {
    return (
      <p className="text-xs text-white/50">
        The Supervisor is not running. Live version control is available when BrowserOS is served through it with <code>npm run supervisor</code>.
      </p>
    );
  }
  if (!state || !branches) return <p className="text-xs text-white/40">Loading...</p>;

  const selectedPreview = state.previews.find((v) => v.branch === selectedBranch) ?? null;
  const isBase = selectedBranch === branches.base;
  const ready = selectedPreview?.state === "ready";
  const stopped = selectedPreview?.state === "stopped";
  const failed = selectedPreview?.state === "failed";
  const building = selectedPreview?.state === "idle" || selectedPreview?.state === "building";
  const btn = "rounded px-2 py-1 text-xs disabled:opacity-40";

  return (
    <div className="space-y-4 text-xs">
      <p className="text-white/50">
        Run feature branches alongside base and promote safely. Base branch <code>{state.baseBranch ?? branches.base}</code> · push mode <code>{state.pushMode}</code>.
      </p>
      <label className="flex items-center gap-2 text-white/60">
        Branch
        <select
          value={selectedBranch || branches.base}
          disabled={busy || building}
          onChange={(e) => setSelectedBranch(e.target.value)}
          className="rounded border border-white/10 bg-black/30 px-2 py-1 text-white/85"
        >
          {branches.branches.map((branch) => (
            <option key={branch} value={branch}>{branch === branches.base ? `${branch} (base)` : branch}</option>
          ))}
        </select>
      </label>
      <div className="space-y-1 rounded border border-white/10 bg-black/20 p-3">
        <VersionRow v={state.base} />
        {state.previews?.map((p) => <VersionRow key={p.branch} v={p} />)}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button disabled={busy || isBase} onClick={() => act("activate", { branch: selectedBranch })} className={`${btn} bg-sky-500/25 hover:bg-sky-500/40`}>Build/start</button>
        <button disabled={busy || !ready} onClick={() => act("pin", { version: "preview", branch: selectedBranch })} className={`${btn} bg-violet-500/30 hover:bg-violet-500/45`}>Preview</button>
        <button disabled={busy} onClick={() => act("pin", { version: "base" })} className={`${btn} bg-white/10 hover:bg-white/20`}>Back to base</button>
        <button disabled={busy || isBase || building || failed} onClick={() => act("promote", { branch: selectedBranch })} className={`${btn} bg-emerald-500/25 hover:bg-emerald-500/40`}>Promote</button>
        <button disabled={busy || !ready} onClick={() => act("stop", { branch: selectedBranch })} className={`${btn} bg-white/10 hover:bg-white/20`} title="Stop the server but keep the worktree + branch">Stop</button>
        <button disabled={busy || isBase || building} onClick={() => act("discard", { branch: selectedBranch })} className={`${btn} bg-red-500/20 hover:bg-red-500/35`} title="Destroy worktree + delete the feature branch">Discard</button>
        <button disabled={busy || !failed} onClick={() => act("build", { branch: selectedBranch })} className={`${btn} bg-amber-500/25 hover:bg-amber-500/40`}>Retry</button>
        <button disabled={busy || !stopped} onClick={() => act("pin", { version: "preview", branch: selectedBranch })} className={`${btn} bg-white/10 hover:bg-white/20`}>Resume</button>
        <button disabled={busy} onClick={() => act("push")} className={`${btn} bg-white/10 hover:bg-white/20`}>Push to remote</button>
        <button disabled={busy} onClick={() => void load()} className={`${btn} bg-white/10 hover:bg-white/20`}>Refresh</button>
      </div>
      {msg && <span className="text-white/60">{msg}</span>}
    </div>
  );
}
