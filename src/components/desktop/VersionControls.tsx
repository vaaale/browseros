"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FileText } from "lucide-react";
import { sessionHeader } from "@/lib/logging/client/session";
import { useLogContextMenu } from "@/components/logging/useLogContextMenu";
import { useOSStore } from "@/store/os-provider";

type PreviewState = "not-built" | "idle" | "building" | "ready" | "failed" | "stopped" | "escalated" | string;

interface Ver {
  role: string;
  branch?: string;
  state: PreviewState;
  buildError?: string;
  /** Present while state is "escalated" — a promote's reconciliation pipeline
   *  handed a conflict to the DevOps Agent. Points at the (persisted,
   *  resumable) conversation so the user can watch/stop/interact with it,
   *  even after a browser refresh. */
  devopsConversationId?: string;
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
  /** Reuse/dev-mode promote: base's `next dev` needs a manual restart (deps/config changed). */
  needsRestart?: boolean;
  message?: string;
  /** Per-remote push outcome from a promote (origin + any autoPush remotes). A
   *  "failed" entry means the promote itself succeeded but the push didn't —
   *  never silent, always surfaced. */
  pushResults?: { remoteName: string; status: "success" | "failed"; error?: string }[];
}
interface LogRecord {
  ts?: number;
  level?: string;
  stream?: string;
  component?: string;
  source?: string;
  msg?: string;
  message?: string;
  err?: { message?: string };
}

const LEVEL_COLOR: Record<string, string> = {
  debug: "text-white/35",
  info: "text-sky-300/80",
  warn: "text-amber-300/90",
  error: "text-red-300/90",
};

const RECENT_ERROR_WINDOW_MS = 15 * 60 * 1000;

function short(s: string): string {
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

// Small top-toolbar log viewer: the whole recent timeline (all streams —
// frontend/backend/supervisor) so the user can spot failures at a glance.
// Errors/warnings are colour-coded; an "errors only" toggle narrows to failures.
function RecentLogPopover({ onClose }: { onClose: () => void }) {
  const [records, setRecords] = useState<LogRecord[]>([]);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const { openMenu, menuNode } = useLogContextMenu();

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch(`/api/logs?limit=200${errorsOnly ? "&level=warn" : ""}`)
        .then((r) => r.json())
        .then((d) => {
          if (alive) setRecords(Array.isArray(d.records) ? d.records : []);
        })
        .catch(() => alive && setRecords([]));
    };
    load();
    const id = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [errorsOnly]);

  // Newest first — most recent activity (and failures) at the top.
  const rows = [...records].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));

  return (
    <div className="absolute right-0 top-7 z-[100001] w-[900px] max-w-[92vw] rounded border border-white/15 bg-neutral-950 p-2 text-[11px] text-white/80 shadow-2xl">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium text-white">Recent log</span>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-white/60">
            <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} /> errors only
          </label>
          <button onClick={onClose} className="rounded bg-white/10 px-2 py-0.5 hover:bg-white/20">Close</button>
        </div>
      </div>
      <div className="max-h-[340px] overflow-auto rounded bg-black/35 p-2 font-mono">
        {rows.length === 0 ? (
          <div className="text-white/45">No log records.</div>
        ) : (
          rows.map((r, i) => (
            <div
              key={i}
              onContextMenu={(e) => openMenu(e, r)}
              className="cursor-default select-text whitespace-pre-wrap border-b border-white/5 py-1 last:border-b-0"
            >
              <span className="text-white/35">{r.ts ? new Date(r.ts).toLocaleTimeString() : "--:--:--"}</span>{" "}
              <span className={`uppercase ${LEVEL_COLOR[r.level ?? "info"] ?? "text-white/60"}`}>{r.level ?? "info"}</span>{" "}
              {r.component && <span className="text-white/45">{r.component}</span>}{" "}
              <span className="text-white/85">{r.msg ?? r.message ?? ""}</span>
              {r.err?.message && <span className="text-red-300/80"> — {r.err.message}</span>}
            </div>
          ))
        )}
      </div>
      {menuNode}
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
  const [recentErrors, setRecentErrors] = useState(0);
  // Epoch ms of the last time the user closed the log popover — errors at or
  // before this point are considered "seen" and excluded from the badge count,
  // so closing the viewer resets the notification instead of it reappearing
  // on the next poll for the same errors within the window.
  const [clearedAt, setClearedAt] = useState(0);

  // Poll the central log for recent errors so the toolbar can flag failures at a
  // glance (red badge on the Log button) without the user opening the popover.
  useEffect(() => {
    let alive = true;
    const poll = () => {
      fetch("/api/logs?level=error&limit=50")
        .then((r) => r.json())
        .then((d) => {
          if (!alive) return;
          const recs: LogRecord[] = Array.isArray(d.records) ? d.records : [];
          const cutoff = Math.max(Date.now() - RECENT_ERROR_WINDOW_MS, clearedAt);
          setRecentErrors(recs.filter((r) => (r.ts ?? 0) > cutoff).length);
        })
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, 12000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [clearedAt]);

  const closeLogs = useCallback(() => {
    setShowLogs(false);
    // Reset immediately for a snappy badge instead of waiting for the next
    // poll tick (up to 12s later) to pick up the new cutoff.
    setRecentErrors(0);
    setClearedAt(Date.now());
  }, []);

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
  const launch = useOSStore((s) => s.launch);

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
  // A promote's shared reconciliation pipeline (001-external-repo-integration,
  // US6) handed a conflict to the DevOps Agent — the conversation is a normal,
  // persisted, resumable one, visible here even after a browser refresh since
  // this is polled server state, not the (possibly still-blocked) promote call.
  const escalated = preview?.state === "escalated";
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
    if (r.ok) {
      const pushFailures = (r.pushResults ?? []).filter((p) => p.status === "failed");
      if (pushFailures.length > 0) {
        window.alert(
          `Promoted, but push failed for: ${pushFailures.map((p) => `${p.remoteName} (${p.error || "unknown error"})`).join("; ")}\n\n` +
            "The promoted code is live on base but NOT pushed to the remote(s) above — push manually from Settings → Versions once resolved.",
        );
      } else if (r.needsRestart) {
        window.alert(r.message || "Promoted. Restart your dev server so base picks up the changes.");
      }
      window.location.reload();
    } else {
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
          {escalated && (
            <span className="flex items-center gap-1 text-amber-300/90" title="A merge conflict during promote was handed to the DevOps Agent — the conversation is live, stoppable, and resumable.">
              escalated to DevOps Agent
              <button
                onClick={() => launch("chat")}
                className={`${btn} bg-amber-500/25 hover:bg-amber-500/40`}
                title="Open the Assistant app — find the conversation in the list (it's titled after the conflict being resolved)"
              >
                Open Assistant
              </button>
            </span>
          )}
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
        title={recentErrors > 0 ? `${recentErrors} error(s) in the last 15 min — click to view the recent log` : "Show recent log (all streams)"}
        className={`${btn} flex items-center gap-1 ${recentErrors > 0 ? "bg-red-500/25 hover:bg-red-500/40" : "bg-white/10 hover:bg-white/20"}`}
      >
        <FileText size={12} />
        Log
        {recentErrors > 0 && (
          <span className="rounded-full bg-red-500/80 px-1 text-[10px] font-semibold leading-tight text-white">
            {recentErrors > 9 ? "9+" : recentErrors}
          </span>
        )}
      </button>
      {err && <span className="ml-1 max-w-[260px] truncate text-red-300/90" title={err}>{short(err)}</span>}
      {showLogs && <RecentLogPopover onClose={closeLogs} />}
    </div>
  );
}
