"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle,
  GitBranch,
  GitMerge,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { sessionHeader } from "@/lib/logging/client/session";
import {
  ConflictResolutionDialog,
  type MergeStrategy,
} from "./ConflictResolutionDialog";

interface SyncStatusEntry {
  remoteName: string;
  branch: string;
  localAhead: number;
  localBehind: number;
  hasUncommittedChanges: boolean;
  conflict: boolean | null;
  lastFetched: string | null;
  lastSynced: string | null;
}

function statusColor(s: SyncStatusEntry): string {
  if (s.conflict) return "text-red-400";
  if (s.localAhead > 0 && s.localBehind > 0) return "text-orange-400";
  if (s.localBehind > 0) return "text-amber-400";
  if (s.localAhead === 0 && s.localBehind === 0) return "text-emerald-400";
  return "text-white/50";
}

function statusDot(s: SyncStatusEntry): string {
  if (s.conflict) return "bg-red-400";
  if (s.localAhead > 0 && s.localBehind > 0) return "bg-orange-400";
  if (s.localBehind > 0) return "bg-amber-400";
  if (s.localAhead === 0 && s.localBehind === 0) return "bg-emerald-400";
  return "bg-white/40";
}

function statusLabel(s: SyncStatusEntry): string {
  if (s.conflict) return "Conflict";
  if (s.localAhead > 0 && s.localBehind > 0) return "Diverged";
  if (s.localBehind > 0) return "Behind";
  if (s.localAhead === 0 && s.localBehind === 0) return "In sync";
  return "Ahead";
}

function formatTime(iso: string | null): string {
  if (!iso) return "Never";
  try {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    if (diff < 60_000) return "Just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}

function aheadBehindText(s: SyncStatusEntry): string {
  const parts: string[] = [];
  if (s.localAhead > 0) parts.push(`${s.localAhead} ahead`);
  if (s.localBehind > 0) parts.push(`${s.localBehind} behind`);
  if (parts.length === 0) return "Up to date";
  return parts.join(", ");
}

export function BranchSyncPanel() {
  const [statuses, setStatuses] = useState<SyncStatusEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchingAll, setFetchingAll] = useState(false);
  const [conflictTarget, setConflictTarget] = useState<SyncStatusEntry | null>(null);
  const [resolving, setResolving] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch("/api/git-sync");
      if (!res.ok) throw new Error("Failed to load sync status");
      const data = await res.json();
      setStatuses(data.statuses ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);

  const fetchAll = async () => {
    setFetchingAll(true);
    try {
      const res = await fetch("/api/git-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionHeader() },
        body: JSON.stringify({ action: "fetch-all" }),
      });
      const data = await res.json();
      if (data.statuses) setStatuses(data.statuses);
    } finally {
      setFetchingAll(false);
    }
  };

  const handleResolve = useCallback(
    async (strategy: MergeStrategy) => {
      if (!conflictTarget) return;
      setResolving(true);
      try {
        const res = await fetch("/api/git-sync", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...sessionHeader() },
          body: JSON.stringify({
            action: "resolve",
            remoteName: conflictTarget.remoteName,
            strategy,
          }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error.message ?? data.error);
        setConflictTarget(null);
        await load();
      } finally {
        setResolving(false);
      }
    },
    [conflictTarget, load],
  );

  const btn = "rounded px-2 py-1 text-[11px] font-medium disabled:opacity-40";

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-white/40">
        <Loader2 size={14} className="animate-spin" />
        Loading sync status…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-white/50">
            Branch Sync
          </h4>
          <p className="mt-1 text-[11px] text-white/40">
            Sync status for all mounted remotes.
          </p>
        </div>
        <button
          onClick={() => void fetchAll()}
          disabled={fetchingAll}
          className={`${btn} inline-flex items-center gap-1 bg-white/10 hover:bg-white/20`}
        >
          {fetchingAll ? (
            <Loader2 size={10} className="animate-spin" />
          ) : (
            <RefreshCw size={10} />
          )}
          Refresh
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded border border-red-400/30 bg-red-500/10 p-2.5 text-[11px] text-red-200">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {statuses.length === 0 ? (
        <div className="rounded-lg border border-white/10 bg-white/[0.03] p-6 text-center">
          <GitBranch size={24} className="mx-auto mb-2 text-white/20" />
          <p className="text-[12px] text-white/40">No mounted remotes.</p>
          <p className="mt-1 text-[11px] text-white/30">
            Mount a remote from the Git Remotes tab to see sync status.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {statuses.map((s) => (
            <div
              key={s.remoteName}
              className={`rounded-lg border p-3 ${
                s.conflict
                  ? "border-red-400/30 bg-red-500/5"
                  : "border-white/10 bg-white/[0.03]"
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium">
                      {s.remoteName}
                    </span>
                    <span className="text-[11px] text-white/40">
                      {s.branch}
                    </span>
                    <span
                      className={`inline-flex items-center gap-1 text-[11px] ${statusColor(s)}`}
                    >
                      <span
                        className={`inline-block h-1.5 w-1.5 rounded-full ${statusDot(s)}`}
                      />
                      {statusLabel(s)}
                    </span>
                  </div>
                  <div className="mt-1.5 flex items-center gap-4 text-[10px] text-white/30">
                    <span>{aheadBehindText(s)}</span>
                    <span>Last fetched: {formatTime(s.lastFetched)}</span>
                    <span>Last synced: {formatTime(s.lastSynced)}</span>
                  </div>
                </div>
                {s.conflict && (
                  <button
                    disabled={resolving}
                    onClick={() => setConflictTarget(s)}
                    className={`${btn} inline-flex items-center gap-1 bg-orange-500/20 text-orange-300/80 hover:bg-orange-500/30`}
                  >
                    <GitMerge size={10} />
                    Resolve
                  </button>
                )}
                {!s.conflict && (s.localAhead > 0 || s.localBehind > 0) && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-white/30">
                    <CheckCircle size={10} />
                    {statusLabel(s)}
                  </span>
                )}
                {!s.conflict && s.localAhead === 0 && s.localBehind === 0 && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400/60">
                    <CheckCircle size={10} />
                    In sync
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {conflictTarget && (
        <ConflictResolutionDialog
          open={true}
          remote={conflictTarget.remoteName}
          branch={conflictTarget.branch}
          ahead={conflictTarget.localAhead}
          behind={conflictTarget.localBehind}
          onResolve={handleResolve}
          onAbort={() => setConflictTarget(null)}
        />
      )}
    </div>
  );
}
