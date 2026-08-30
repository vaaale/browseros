"use client";

import { useCallback, useState } from "react";
import { AlertCircle, FileWarning, GitMerge, Loader2, X } from "lucide-react";
import { ConflictSessionBadge } from "@/components/gitops/ConflictSessionBadge";

export type MergeStrategy = "merge-squash" | "merge" | "commit";

export interface ConflictResolutionDialogProps {
  open: boolean;
  remote: string;
  branch: string;
  ahead: number;
  behind: number;
  conflictingFiles?: string[];
  /** 035 (FR-019): when the divergence was escalated, this is the live
   *  resolution session — the dialog shows its state and links into the
   *  Build Studio conflict pane instead of only offering blind strategies. */
  sessionId?: string;
  devopsConversationId?: string;
  onResolve: (strategy: MergeStrategy) => Promise<void>;
  onAbort: () => void;
}

export function ConflictResolutionDialog({
  open,
  remote,
  branch,
  ahead,
  behind,
  conflictingFiles = [],
  sessionId,
  devopsConversationId,
  onResolve,
  onAbort,
}: ConflictResolutionDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedStrategy, setSelectedStrategy] = useState<MergeStrategy | null>(null);

  const handleResolve = useCallback(
    async (strategy: MergeStrategy) => {
      setBusy(true);
      setError(null);
      setSelectedStrategy(strategy);
      try {
        await onResolve(strategy);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
        setSelectedStrategy(null);
      }
    },
    [onResolve],
  );

  if (!open) return null;

  const strategies: {
    value: MergeStrategy;
    label: string;
    description: string;
    recommended?: boolean;
  }[] = [
    {
      value: "merge-squash",
      label: "Merge --squash",
      description: "Squashes all remote commits into a single commit on top of local changes.",
      recommended: true,
    },
    {
      value: "merge",
      label: "Merge",
      description: "Creates a standard merge commit preserving full history.",
    },
    {
      value: "commit",
      label: "Commit",
      description: "Stashes local changes, commits remote, then restores stash.",
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-lg rounded-lg border border-white/10 bg-neutral-900 p-4 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileWarning size={16} className="text-amber-400" />
            <h4 className="text-sm font-semibold">Branch Conflict Detected</h4>
          </div>
          <button
            onClick={onAbort}
            className="rounded p-1 text-white/50 hover:bg-white/10 hover:text-white"
          >
            <X size={14} />
          </button>
        </div>

        <div className="mb-3 rounded border border-amber-400/20 bg-amber-500/10 p-3">
          <p className="text-[12px] text-amber-200">
            The local branch has diverged from{" "}
            <span className="font-mono font-medium">{remote}/{branch}</span>.
          </p>
          <div className="mt-2 flex gap-4 text-[11px] text-amber-300/70">
            <span>Ahead: {ahead}</span>
            <span>Behind: {behind}</span>
          </div>
        </div>

        {(sessionId || devopsConversationId) && (
          <div className="mb-3">
            <ConflictSessionBadge variant="block" sessionId={sessionId} conversationId={devopsConversationId} />
          </div>
        )}

        {conflictingFiles.length > 0 && !sessionId && (
          <div className="mb-3">
            <p className="mb-1.5 text-[11px] font-medium text-white/60">
              Conflicting files ({conflictingFiles.length}):
            </p>
            <div className="max-h-32 overflow-y-auto rounded border border-white/10 bg-black/30 p-2">
              {conflictingFiles.map((file) => (
                <div
                  key={file}
                  className="flex items-center gap-2 py-0.5 font-mono text-[11px] text-white/70"
                >
                  <GitMerge size={10} className="shrink-0 text-amber-400/60" />
                  {file}
                </div>
              ))}
            </div>
          </div>
        )}

        <p className="mb-2 text-[11px] text-white/50">
          {sessionId
            ? "The agent is on it. You can still force a deterministic strategy instead — that abandons the agent's in-progress resolution:"
            : "Choose a resolution strategy to merge the remote changes:"}
        </p>

        <div className="space-y-2">
          {strategies.map((s) => (
            <button
              key={s.value}
              onClick={() => void handleResolve(s.value)}
              disabled={busy}
              className={`w-full rounded border p-3 text-left transition-colors ${
                busy && selectedStrategy === s.value
                  ? "border-violet-500/50 bg-violet-500/10"
                  : "border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.05]"
              } disabled:opacity-50`}
            >
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-medium">{s.label}</span>
                {s.recommended && (
                  <span className="rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px] font-medium text-violet-300">
                    Recommended
                  </span>
                )}
                {busy && selectedStrategy === s.value && (
                  <Loader2 size={12} className="ml-auto animate-spin text-violet-400" />
                )}
              </div>
              <p className="mt-1 text-[11px] text-white/40">{s.description}</p>
            </button>
          ))}
        </div>

        {error && (
          <div className="mt-3 flex items-start gap-2 rounded border border-red-400/30 bg-red-500/10 p-2 text-[11px] text-red-200">
            <AlertCircle size={12} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="mt-4 flex justify-end">
          <button
            onClick={onAbort}
            disabled={busy}
            className="rounded border border-white/15 px-3 py-1.5 text-[11px] font-medium text-white/70 hover:bg-white/10 disabled:opacity-50"
          >
            Abort
          </button>
        </div>
      </div>
    </div>
  );
}
