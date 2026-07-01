"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { sessionHeader, getSessionId } from "@/lib/logging/client/session";
import { useActiveConversationId } from "@/lib/agent/conversations";

interface Ver {
  role: string;
  branch?: string;
  state: string;
  buildError?: string;
  buildLog?: string;
  conversationId?: string;
}
interface SupState {
  base: Ver | null;
  previews: Ver[];
  appCandidate: { branch: string; base: string } | null;
  // Which running version THIS session is being served (resolved from the pin
  // cookie). Absent on older Supervisors → treated as "not previewing".
  serving?: { role: string; branch?: string; conversationId?: string } | null;
}
interface Branches {
  branches: string[];
  base: string;
}
interface PostResult {
  ok?: boolean;
  error?: string;
}

// Compact live-version-control surface in the Topbar. Renders nothing unless
// BrowserOS is served through the Supervisor (so /__supervisor/* resolves).
//
// Shape: `Base: <branch ▾>`. The dropdown lists every git branch; choosing one
// builds it as a preview and pins this session to it. While a preview exists its
// [Preview] / [Stop] / [Discard] / [Promote] controls appear: Preview points THIS
// session at the preview (an agent-built preview isn't auto-served — without
// Preview you'd still be on base, the "fix is in but nothing changed" trap); Stop
// stops the preview server but keeps the worktree + branch (can resume via
// Preview); Discard destroys the worktree and deletes the branch; Promote makes
// it the new base. Failures are surfaced inline rather than silently swallowed.
//
// The conversationId for preview operations is the active chat conversation ID
// (same one the agent uses), so the UI and agent share the same preview slot.
// Falls back to the browser session ID when no conversation is active.
export function VersionControls() {
  const activeConversationId = useActiveConversationId();
  const [branches, setBranches] = useState<Branches | null>(null);
  const [state, setState] = useState<SupState | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // The branch we just asked to build. Once its preview finishes building we
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

  // Flip the session into a freshly-built preview as soon as it is ready.
  useEffect(() => {
    const target = pendingRef.current;
    if (!target) return;
    // Match by branch name — activate() may reuse a preview owned by a different
    // conversationId (e.g. one created by the agent).
    const p = state?.previews?.find((v) => v.branch === target);
    if (p?.state === "ready") {
      pendingRef.current = null;
      window.location.reload();
    }
  }, [state]);

  const post = useCallback(async (p: string, body?: Record<string, unknown>): Promise<PostResult> => {
    setBusy(true);
    try {
      const r = await fetch(`/__supervisor/${p}`, {
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

  if (!branches) return null;

  const activeCid = activeConversationId || getSessionId();
  const serving = state?.serving ?? null;
  const servedPreview = serving?.role === "preview"
    ? state?.previews?.find((v) =>
      (serving.conversationId && v.conversationId === serving.conversationId) ||
      (serving.branch && v.branch === serving.branch),
    ) ?? null
    : null;
  const activeCand = state?.previews?.find((v) => v.conversationId === activeCid) ?? null;
  // Prefer the preview this tab is actually viewing. The active chat can change
  // while a preview is open, and existing branch previews may be owned by another
  // conversation id.
  const cand = servedPreview ?? activeCand;
  const cid = cand?.conversationId ?? activeCid;
  const hasCand = !!cand;
  const ready = cand?.state === "ready";
  const building = cand?.state === "idle" || cand?.state === "building";
  const failed = cand?.state === "failed";
  const stopped = cand?.state === "stopped";
  const previewing = hasCand && serving?.role === "preview" && (
    (!!cand?.conversationId && serving.conversationId === cand.conversationId) ||
    (!!cand?.branch && serving.branch === cand.branch)
  );
  // What this session is actually being served (not just "a preview exists").
  const selectedValue = state?.serving?.branch ?? branches.base;
  const app = state?.appCandidate ?? null;

  const onSelect = async (branch: string) => {
    if (branch === selectedValue) return;
    setErr(null);
    if (branch === branches.base) {
      // Back to base — stop any preview for this tab and clear the pin.
      pendingRef.current = null;
      const r = await post("activate", { conversationId: cid, branch });
      if (r?.ok) window.location.reload();
      else setErr(r?.error || "Failed to return to base.");
      return;
    }
    // Build the chosen branch as a preview; the ready-watcher reloads us in.
    pendingRef.current = branch;
    const r = await post("activate", { conversationId: cid, branch });
    if (!r?.ok) {
      pendingRef.current = null;
      setErr(r?.error || `Failed to build branch ${branch}.`);
    }
    await load();
  };
  const onPreview = async () => {
    setErr(null);
    const r = await post("pin", { version: "preview", conversationId: cid });
    if (r?.ok) window.location.reload();
    else setErr(r?.error || "Failed to preview.");
  };
  const onStop = async () => {
    setErr(null);
    // Stop = stop the preview server but KEEP worktree + branch (can resume).
    const r = await post("stop", { conversationId: cid });
    if (r?.ok) window.location.reload();
    else {
      setErr(r?.error || "Stop failed.");
      await load();
    }
  };
  const onDiscard = async () => {
    setErr(null);
    // Discard = destroy worktree + delete the feature branch.
    const r = await post("discard", { conversationId: cid });
    if (r?.ok) window.location.reload();
    else {
      setErr(r?.error || "Discard failed.");
      await load();
    }
  };
  const onPromote = async () => {
    pendingRef.current = null;
    setErr(null);
    // Promote can fail (dirty base checkout, conflict, failed health check); surface
    // the reason instead of silently doing nothing, and keep the preview visible.
    const r = await post("promote", { conversationId: cid });
    if (r?.ok) window.location.reload();
    else {
      setErr(r?.error || "Promote failed.");
      await load();
    }
  };
  const onApp = async (p: "app-promote" | "app-discard") => {
    setErr(null);
    const r = await post(p);
    if (!r?.ok) setErr(r?.error || `${p === "app-promote" ? "Promote" : "Discard"} app failed.`);
    await load();
  };

  const btn = "rounded px-1.5 py-0.5 transition-colors disabled:opacity-40 disabled:cursor-default";
  const short = (s: string) => (s.length > 80 ? `${s.slice(0, 77)}…` : s);

  return (
    <div className="flex items-center gap-1 text-[11px]">
      {app && (
        <>
          <span className="text-white/55" title={`app preview on branch ${app.branch} (base ${app.base})`}>app preview</span>
          <button disabled={busy} onClick={() => void onApp("app-promote")} className={`${btn} bg-emerald-500/25 hover:bg-emerald-500/40`}>Promote app</button>
          <button disabled={busy} onClick={() => void onApp("app-discard")} className={`${btn} bg-white/10 hover:bg-white/20`}>Discard app</button>
          <span className="mx-0.5 text-white/20">|</span>
        </>
      )}
      <span className="text-white/55">Base:</span>
      <select
        value={selectedValue}
        disabled={busy}
        onChange={(e) => void onSelect(e.target.value)}
        title={previewing ? `Previewing branch ${selectedValue}` : "Base version — pick a branch to preview it"}
        className="max-w-[180px] truncate rounded bg-white/10 px-1.5 py-0.5 text-white/90 outline-none transition-colors hover:bg-white/20 disabled:opacity-40"
      >
        {(branches.branches.includes(selectedValue) ? branches.branches : [selectedValue, ...branches.branches]).map((b) => (
          <option key={b} value={b} className="bg-neutral-900 text-white">
            {b === branches.base ? `${b} (base)` : b}
          </option>
        ))}
      </select>
      {hasCand && (
        <>
          {building && <span className="text-amber-300/80">building…</span>}
          {failed && (
            <span className="max-w-[280px] truncate text-red-300/80" title={cand?.buildError || "build failed"}>
              build failed{cand?.buildError ? `: ${short((cand.buildError.split("\n").pop() || cand.buildError).trim())}` : ""}
            </span>
          )}
          {stopped && !previewing && (
            <span className="text-white/50" title="Preview server stopped — worktree + branch kept">stopped</span>
          )}
          {(ready || stopped) && !previewing && (
            <button disabled={busy} onClick={onPreview} title={stopped ? "Resume the stopped preview server and view it" : "View this preview in the browser (it is not the base version yet)"} className={`${btn} bg-sky-500/25 hover:bg-sky-500/40`}>Preview</button>
          )}
          {previewing && (
            <span className="text-emerald-300/80" title="You are viewing the preview, not the base version">previewing</span>
          )}
          <button disabled={busy || !ready} onClick={onPromote} title={ready ? "Make this preview the base version" : "Preview must finish building first"} className={`${btn} bg-emerald-500/25 hover:bg-emerald-500/40`}>Promote</button>
          <button disabled={busy || stopped} onClick={onStop} title="Stop the preview server but keep the worktree + branch (can resume via Preview)" className={`${btn} bg-white/10 hover:bg-white/20`}>Stop</button>
          <button disabled={busy} onClick={onDiscard} title="Destroy the worktree and delete the feature branch permanently" className={`${btn} bg-red-500/20 hover:bg-red-500/35`}>Discard</button>
        </>
      )}
      {err && <span className="ml-1 max-w-[260px] truncate text-red-300/90" title={err}>{short(err)}</span>}
    </div>
  );
}
