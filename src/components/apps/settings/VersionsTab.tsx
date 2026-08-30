"use client";

import { useCallback, useEffect, useState } from "react";
import { GitRemotesTab } from "./versions/GitRemotesTab";
import { supervisorPost, promoteIssues, type Ver, type SupState, type Branches } from "@/lib/supervisor/client";
import { ConflictSessionBadge } from "@/components/gitops/ConflictSessionBadge";

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
  /** 035 (FR-018): set when an operation issued from this tab escalated a
   *  conflict — the session badge below links into the resolution pane. */
  const [conflictSessionId, setConflictSessionId] = useState<string | undefined>();

  // Git identity used for commits BOS makes on the user's behalf (pulls,
  // rebases, merges) — namespace "self-modification", so it lives alongside
  // every other Versions setting. Missing/unset identity is what caused
  // "Committer identity unknown" on a Pull with no ambient git config.
  const [gitName, setGitName] = useState("");
  const [gitEmail, setGitEmail] = useState("");
  const [identityMsg, setIdentityMsg] = useState<string | null>(null);
  const [identitySaving, setIdentitySaving] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/config")
      .then((r) => r.json())
      .then((cfg) => {
        if (!alive) return;
        const ns = (cfg.schemas ?? []).find((s: { namespace: string }) => s.namespace === "self-modification");
        setGitName((ns?.values?.gitName as string) || "");
        setGitEmail((ns?.values?.gitEmail as string) || "");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const saveIdentity = async () => {
    setIdentitySaving(true);
    setIdentityMsg(null);
    try {
      await fetch("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ namespace: "self-modification", values: { gitName, gitEmail } }),
      });
      setIdentityMsg("Saved.");
    } catch (e) {
      setIdentityMsg(`Error: ${(e as Error).message}`);
    } finally {
      setIdentitySaving(false);
    }
  };

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
      setSelectedBranch((current) => {
        if (current && nextBranches.branches.includes(current)) return current;
        // Previously-selected branch no longer exists (deleted by a
        // promote/discard, possibly from another tab) — fall back rather
        // than keep pointing at a gone branch.
        return nextState.serving?.branch || nextBranches.base;
      });
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
      const j = await supervisorPost(path, body);
      // 035 (FR-018/FR-019): a promote that escalated a conflict carries the
      // resolution session id — surface the live session here rather than
      // just a terse "Error:" line the user can do nothing with.
      if (j.sessionId) setConflictSessionId(j.sessionId);
      setMsg(j.ok === false ? `Error: ${j.error}` : "Done.");
      if (j.ok !== false && !j.sessionId && (path === "pin" || path === "stop" || path === "discard" || path === "promote")) {
        const issues = path === "promote" ? promoteIssues(j) : null;
        if (issues) window.alert(`Promoted, but with issues:\n\n${issues.join("\n")}`);
        window.location.reload();
      }
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
  // Any preview currently sitting in the escalated state — its session is what
  // the badge below links into, even if this tab never issued the promote.
  const escalatedPreview = state.previews.find((v) => v.state === "escalated") ?? null;
  const isBase = selectedBranch === branches.base;
  // What THIS session is actually being served (server-derived from the pin
  // cookie) — not `isBase`, which only reflects the dropdown selection. Base
  // can already be serving while a different branch sits selected above.
  const viewingBase = state.serving?.role !== "preview";
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
      <div className="space-y-2 rounded border border-white/10 bg-black/20 p-3">
        <div className="font-semibold text-white/70">Git identity</div>
        <p className="text-white/45">
          Name and email used for git commits BOS makes on your behalf (pulls, pushes, rebases, merges) across System Specs, User Specs, User Apps, and BOS Source. Leave blank to use <code>BrowserOS &lt;bos@localhost&gt;</code>.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={gitName}
            onChange={(e) => setGitName(e.target.value)}
            placeholder="BrowserOS"
            className="rounded border border-white/10 bg-black/30 px-2 py-1 text-white/85 outline-none focus:border-white/30"
          />
          <input
            value={gitEmail}
            onChange={(e) => setGitEmail(e.target.value)}
            placeholder="bos@localhost"
            className="rounded border border-white/10 bg-black/30 px-2 py-1 text-white/85 outline-none focus:border-white/30"
          />
          <button disabled={identitySaving} onClick={() => void saveIdentity()} className={`${btn} bg-white/10 hover:bg-white/20`}>
            {identitySaving ? "Saving…" : "Save"}
          </button>
          {identityMsg && <span className="text-white/60">{identityMsg}</span>}
        </div>
      </div>
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
        <button disabled={busy || viewingBase} onClick={() => act("pin", { version: "base" })} className={`${btn} bg-white/10 hover:bg-white/20`}>Back to base</button>
        <button disabled={busy || isBase || building || failed} onClick={() => act("promote", { branch: selectedBranch })} className={`${btn} bg-emerald-500/25 hover:bg-emerald-500/40`}>Promote</button>
        <button disabled={busy || !ready} onClick={() => act("stop", { branch: selectedBranch })} className={`${btn} bg-white/10 hover:bg-white/20`} title="Stop the server but keep the worktree + branch">Stop</button>
        <button
          disabled={busy || isBase || building}
          onClick={() => {
            if (window.confirm(`Discard ${selectedBranch}? This destroys its worktree and deletes the branch — any uncommitted work is lost.`)) {
              void act("discard", { branch: selectedBranch });
            }
          }}
          className={`${btn} bg-red-500/20 hover:bg-red-500/35`}
          title="Destroy worktree + delete the feature branch"
        >
          Discard
        </button>
        <button disabled={busy || !failed} onClick={() => act("build", { branch: selectedBranch })} className={`${btn} bg-amber-500/25 hover:bg-amber-500/40`}>Retry</button>
        <button disabled={busy || !stopped} onClick={() => act("pin", { version: "preview", branch: selectedBranch })} className={`${btn} bg-white/10 hover:bg-white/20`}>Resume</button>
        <button disabled={busy} onClick={() => act("push")} className={`${btn} bg-white/10 hover:bg-white/20`}>Push to remote</button>
        <button disabled={busy} onClick={() => void load()} className={`${btn} bg-white/10 hover:bg-white/20`}>Refresh</button>
      </div>
      {msg && <span className="text-white/60">{msg}</span>}
      {(conflictSessionId || escalatedPreview) && (
        <ConflictSessionBadge
          variant="block"
          sessionId={conflictSessionId ?? escalatedPreview?.conflictSessionId}
          conversationId={escalatedPreview?.devopsConversationId}
        />
      )}
      <hr className="border-white/10" />
      <GitRemotesTab />
    </div>
  );
}
