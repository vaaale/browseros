"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Ver {
  role: string;
  branch?: string;
  state: string;
}
interface SupState {
  active: Ver | null;
  next: Ver | null;
  previous: Ver | null;
  appCandidate: { branch: string; base: string } | null;
}
interface Branches {
  branches: string[];
  base: string;
}

// Compact live-version-control surface in the Topbar. Renders nothing unless
// BrowserOS is served through the Supervisor (so /__supervisor/* resolves).
//
// Shape: `Active: <branch ▾>`. The dropdown lists every git branch; choosing one
// builds it as a candidate and pins this browser session to it. While viewing a
// non-base branch the candidate's [Promote] / [Discard] controls appear. Base =
// the running active version (no candidate).
export function VersionControls() {
  const [branches, setBranches] = useState<Branches | null>(null);
  const [state, setState] = useState<SupState | null>(null);
  const [busy, setBusy] = useState(false);
  // The branch we just asked to activate. Once its candidate finishes building we
  // reload so the session flips into it (the pin only routes once it is ready).
  const pendingRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [bRes, sRes] = await Promise.all([
        fetch("/__supervisor/branches"),
        fetch("/__supervisor/state"),
      ]);
      if (bRes.ok) setBranches((await bRes.json()) as Branches);
      if (sRes.ok) setState((await sRes.json()) as SupState);
    } catch {
      // Keep the last good snapshot on a transient poll failure.
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const id = setInterval(load, 2500);
    return () => clearInterval(id);
  }, [load]);

  // Flip the session into a freshly-built candidate as soon as it is ready.
  useEffect(() => {
    const target = pendingRef.current;
    if (target && state?.next?.branch === target && state.next.state === "ready") {
      pendingRef.current = null;
      window.location.reload();
    }
  }, [state]);

  const post = useCallback(async (p: string, body?: Record<string, unknown>) => {
    setBusy(true);
    try {
      const r = await fetch(`/__supervisor/${p}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      return await r.json();
    } finally {
      setBusy(false);
    }
  }, []);

  if (!branches) return null;

  const cand = state?.next ?? null;
  const selectedValue = cand?.branch ?? branches.base;
  const onBase = !cand;
  const ready = cand?.state === "ready";
  const building = cand?.state === "idle" || cand?.state === "building";
  const failed = cand?.state === "failed" || cand?.state === "tests-failed";
  const app = state?.appCandidate ?? null;

  const onSelect = async (branch: string) => {
    if (branch === selectedValue) return;
    if (branch === branches.base) {
      // Back to the active version — drop any candidate and clear the pin.
      pendingRef.current = null;
      await post("activate", { branch });
      window.location.reload();
      return;
    }
    // Build the chosen branch as a candidate; the ready-watcher reloads us in.
    pendingRef.current = branch;
    await post("activate", { branch });
    await load();
  };
  const onPromote = async () => {
    pendingRef.current = null;
    // Promote can fail (e.g. a branch that isn't a fast-forward of base); only
    // flip to the merged active on success, otherwise keep the candidate visible.
    const r = await post("promote");
    if (r?.ok) window.location.reload();
    else await load();
  };
  const onDiscard = async () => {
    pendingRef.current = null;
    await post("discard");
    window.location.reload();
  };

  const btn = "rounded px-1.5 py-0.5 transition-colors disabled:opacity-40 disabled:cursor-default";

  return (
    <div className="flex items-center gap-1 text-[11px]">
      {app && (
        <>
          <span className="text-white/55" title={`app preview on branch ${app.branch} (base ${app.base})`}>app preview</span>
          <button disabled={busy} onClick={() => void post("app-promote").then(load)} className={`${btn} bg-emerald-500/25 hover:bg-emerald-500/40`}>Promote app</button>
          <button disabled={busy} onClick={() => void post("app-discard").then(load)} className={`${btn} bg-white/10 hover:bg-white/20`}>Discard app</button>
          <span className="mx-0.5 text-white/20">|</span>
        </>
      )}
      <span className="text-white/55">Active:</span>
      <select
        value={selectedValue}
        disabled={busy}
        onChange={(e) => void onSelect(e.target.value)}
        title={onBase ? "Active version — pick a branch to preview it" : `Previewing branch ${selectedValue}`}
        className="max-w-[180px] truncate rounded bg-white/10 px-1.5 py-0.5 text-white/90 outline-none transition-colors hover:bg-white/20 disabled:opacity-40"
      >
        {(branches.branches.includes(selectedValue) ? branches.branches : [selectedValue, ...branches.branches]).map((b) => (
          <option key={b} value={b} className="bg-neutral-900 text-white">
            {b === branches.base ? `${b} (active)` : b}
          </option>
        ))}
      </select>
      {!onBase && (
        <>
          {building && <span className="text-amber-300/80">building…</span>}
          {failed && <span className="text-red-300/80">build failed</span>}
          <button disabled={busy || !ready} onClick={onPromote} className={`${btn} bg-emerald-500/25 hover:bg-emerald-500/40`}>Promote</button>
          <button disabled={busy} onClick={onDiscard} className={`${btn} bg-white/10 hover:bg-white/20`}>Discard</button>
        </>
      )}
    </div>
  );
}
