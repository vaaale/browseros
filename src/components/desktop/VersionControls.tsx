"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FileText } from "lucide-react";
import { sessionHeader } from "@/lib/logging/client/session";

type PreviewState = "not-built" | "idle" | "building" | "ready" | "failed" | "stopped" | string;

interface Ver {
  role: string;
  branch?: string;
  state: PreviewState;
  buildError?: string;
}
interface SupState {
  base: Ver | null;
  previews: Ver[];
  appCandidate: { branch: string; base: string } | null;
  serving?: { role: string; branch?: string } | null;
}
interface Branches {
  branches: string[];
  base: string;
}
interface PostResult {
  ok?: boolean;
  error?: string;
  state?: string;
}
interface LogRecord {
  ts?: number;
  level?: string;
  source?: string;
  msg?: string;
  message?: string;
}

function short(s: string): string {
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

function SupervisorLogPopover({ onClose }: { onClose: () => void }) {
  const [records, setRecords] = useState<LogRecord[]>([]);

  useEffect(() => {
    let alive = true;
    fetch("/__supervisor/logs?stream=supervisor&limit=80")
      .then((r) => r.json())
      .then((d) => {
        if (alive) setRecords(Array.isArray(d.records) ? d.records : []);
      })
      .catch(() => alive && setRecords([]));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="absolute right-0 top-7 z-[100001] w-[520px] max-w-[80vw] rounded border border-white/15 bg-neutral-950 p-2 text-[11px] text-white/80 shadow-2xl">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium text-white">Supervisor log</span>
        <button onClick={onClose} className="rounded bg-white/10 px-2 py-0.5 hover:bg-white/20">Close</button>
      </div>
      <div className="max-h-[320px] overflow-auto rounded bg-black/35 p-2 font-mono">
        {records.length === 0 ? (
          <div className="text-white/45">No supervisor log records.</div>
        ) : (
          records.map((r, i) => (
            <div key={i} className="whitespace-pre-wrap border-b border-white/5 py-1 last:border-b-0">
              <span className="text-white/35">{r.ts ? new Date(r.ts).toLocaleTimeString() : "--:--:--"}</span>{" "}
              <span className="text-white/50">{r.level ?? "info"}</span>{" "}
              <span>{r.msg ?? r.message ?? ""}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function VersionControls() {
  const [branches, setBranches] = useState<Branches | null>(null);
  const [state, setState] = useState<SupState | null>(null);
  const [selectedBranch, setSelectedBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);

  const load = useCallback(async () => {
    try {
      const [bRes, sRes] = await Promise.all([
        fetch("/__supervisor/branches"),
        fetch("/__supervisor/state"),
      ]);
      if (!bRes.ok || !sRes.ok) return;
      const nextBranches = (await bRes.json()) as Branches;
      const nextState = (await sRes.json()) as SupState;
      setBranches(nextBranches);
      setState(nextState);
      const servingBranch = nextState.serving?.branch;
      setSelectedBranch((current) => current || servingBranch || nextBranches.base);
    } catch {
      // Supervisor endpoints do not exist when BOS is not served through it.
    }
  }, []);

  useEffect(() => {
    const initial = setTimeout(() => void load(), 0);
    const interval = setInterval(load, 2500);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [load]);

  const post = useCallback(async (path: string, body?: Record<string, unknown>): Promise<PostResult> => {
    setBusy(true);
    try {
      const r = await fetch(`/__supervisor/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionHeader() },
        body: JSON.stringify(body ?? {}),
      });
      return (await r.json()) as PostResult;
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    } finally {
      setBusy(false);
    }
  }, []);

  const preview = useMemo(
    () => state?.previews.find((p) => p.branch === selectedBranch) ?? null,
    [selectedBranch, state?.previews],
  );

  if (!branches || !state) return null;

  const baseBranch = branches.base;
  const viewingBase = state.serving?.role !== "preview";
  const previewingSelected = state.serving?.role === "preview" && state.serving.branch === selectedBranch;
  const isBaseSelection = selectedBranch === baseBranch;
  const stateText = viewingBase ? "BASE" : "PREVIEW";
  const building = preview?.state === "idle" || preview?.state === "building";
  const ready = preview?.state === "ready";
  const stopped = preview?.state === "stopped";
  const failed = preview?.state === "failed";
  const notBuilt = preview?.state === "not-built";
  const hasFeatureSelection = !isBaseSelection && !!selectedBranch;
  const selectDisabled = busy || building;
  const app = state.appCandidate;

  const onSelect = async (branch: string) => {
    setSelectedBranch(branch);
    setErr(null);
    if (branch === baseBranch) {
      const r = await post("pin", { version: "base" });
      if (r.ok) window.location.reload();
      else setErr(r.error || "Failed to switch to base.");
      return;
    }

    const existing = state.previews.find((p) => p.branch === branch);
    if (existing?.state === "ready") {
      const r = await post("pin", { version: "preview", branch });
      if (r.ok) window.location.reload();
      else setErr(r.error || `Failed to switch to ${branch}.`);
      return;
    }

    const r = await post("activate", { branch });
    if (!r.ok) setErr(r.error || `Failed to build ${branch}.`);
    await load();
  };

  const pinPreview = async () => {
    setErr(null);
    const r = await post("pin", { version: "preview", branch: selectedBranch });
    if (r.ok) window.location.reload();
    else setErr(r.error || "Failed to preview.");
  };
  const stopPreview = async () => {
    setErr(null);
    const r = await post("stop", { branch: selectedBranch });
    if (r.ok) window.location.reload();
    else {
      setErr(r.error || "Stop failed.");
      await load();
    }
  };
  const discardPreview = async () => {
    setErr(null);
    const r = await post("discard", { branch: selectedBranch });
    if (r.ok) window.location.reload();
    else {
      setErr(r.error || "Discard failed.");
      await load();
    }
  };
  const promotePreview = async () => {
    setErr(null);
    const r = await post("promote", { branch: selectedBranch });
    if (r.ok) window.location.reload();
    else {
      setErr(r.error || "Promote failed.");
      await load();
    }
  };
  const retryBuild = async () => {
    setErr(null);
    const r = await post("build", { branch: selectedBranch });
    if (!r.ok) setErr(r.error || "Build failed.");
    await load();
  };
  const onApp = async (path: "app-promote" | "app-discard") => {
    setErr(null);
    const r = await post(path);
    if (!r.ok) setErr(r.error || `${path === "app-promote" ? "Promote" : "Discard"} app failed.`);
    await load();
  };

  const btn = "rounded px-1.5 py-0.5 transition-colors disabled:cursor-default disabled:opacity-40";

  return (
    <div className="relative flex items-center gap-1 text-[11px]">
      <span className={`px-2 text-sm font-semibold tracking-wide ${viewingBase ? "text-sky-200" : "text-amber-200"}`}>
        {stateText}
      </span>
      {app && (
        <>
          <span className="text-white/55" title={`app preview on branch ${app.branch} (base ${app.base})`}>app preview</span>
          <button disabled={busy} onClick={() => void onApp("app-promote")} className={`${btn} bg-emerald-500/25 hover:bg-emerald-500/40`}>Promote app</button>
          <button disabled={busy} onClick={() => void onApp("app-discard")} className={`${btn} bg-white/10 hover:bg-white/20`}>Discard app</button>
          <span className="mx-0.5 text-white/20">|</span>
        </>
      )}
      <select
        value={selectedBranch || baseBranch}
        disabled={selectDisabled}
        onChange={(e) => void onSelect(e.target.value)}
        title={viewingBase ? "Base version - pick a feature branch to build or preview it" : "Preview version - pick a running branch or base"}
        className="max-w-[220px] truncate rounded bg-white/10 px-1.5 py-0.5 text-white/90 outline-none transition-colors hover:bg-white/20 disabled:opacity-40"
      >
        {(branches.branches.includes(selectedBranch) || !selectedBranch ? branches.branches : [selectedBranch, ...branches.branches]).map((b) => (
          <option key={b} value={b} className="bg-neutral-900 text-white">
            {b === baseBranch ? `${b} (base)` : b}
          </option>
        ))}
      </select>
      {hasFeatureSelection && (
        <>
          {building && <span className="text-amber-300/90">building {selectedBranch}...</span>}
          {notBuilt && <span className="text-white/50">not built</span>}
          {failed && (
            <span className="max-w-[260px] truncate text-red-300/90" title={preview?.buildError || "build failed"}>
              failed{preview?.buildError ? `: ${short((preview.buildError.split("\n").pop() || preview.buildError).trim())}` : ""}
            </span>
          )}
          {stopped && <span className="text-white/50">stopped</span>}
          {!previewingSelected && (
            <button disabled={busy || (!ready && !stopped)} onClick={pinPreview} className={`${btn} bg-sky-500/25 hover:bg-sky-500/40`}>Preview</button>
          )}
          {previewingSelected && <span className="text-emerald-300/90">previewing</span>}
          {failed && <button disabled={busy} onClick={retryBuild} className={`${btn} bg-amber-500/25 hover:bg-amber-500/40`}>Retry</button>}
          <button disabled={busy || building || failed} onClick={promotePreview} title="Build if needed, then make this branch the base version" className={`${btn} bg-emerald-500/25 hover:bg-emerald-500/40`}>Promote</button>
          <button disabled={busy || building || stopped || notBuilt} onClick={stopPreview} title="Stop the preview server but keep the branch/worktree" className={`${btn} bg-white/10 hover:bg-white/20`}>Stop</button>
          <button disabled={busy || building} onClick={discardPreview} title="Destroy the worktree and delete the feature branch" className={`${btn} bg-red-500/20 hover:bg-red-500/35`}>Discard</button>
        </>
      )}
      <button
        disabled={busy}
        onClick={() => setShowLogs((v) => !v)}
        title="Show Supervisor log"
        className={`${btn} flex items-center gap-1 bg-white/10 hover:bg-white/20`}
      >
        <FileText size={12} />
        Log
      </button>
      {err && <span className="ml-1 max-w-[260px] truncate text-red-300/90" title={err}>{short(err)}</span>}
      {showLogs && <SupervisorLogPopover onClose={() => setShowLogs(false)} />}
    </div>
  );
}
