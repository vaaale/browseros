"use client";

import { useState } from "react";
import { Copy, Undo2 } from "lucide-react";
import type { ConflictSession } from "@/lib/gitops/sessions/types";
import { STATUS_META, baseName } from "./status";

// The pane's status header (mockup `.status`): the status pill, the session
// metadata (repo · branch · rollback tag · operation), the abandon affordance,
// and the compact per-file decision chip strip (D7 — the full narrative lives
// in the chat, not in a drawer).

interface Props {
  session: ConflictSession;
  selected: string | undefined;
  onSelect: (path: string) => void;
  onAbandon: () => void;
  busy: boolean;
}

export function ConflictStatusHeader({ session, selected, onSelect, onAbandon, busy }: Props) {
  const [copied, setCopied] = useState(false);
  const meta = STATUS_META[session.status];
  const awaitingPath = session.pendingDecision?.path;
  const open = session.files.filter((f) => f.resolvedContent === undefined && !f.waived).length;
  const done = session.files.length - open;

  const copyTag = () => {
    void navigator.clipboard?.writeText(session.rollbackTag).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="shrink-0 border-b border-white/10 bg-white/[0.03]">
      <div className="flex items-center gap-3 px-3.5 py-2">
        <span
          data-testid="conflict-status-pill"
          data-status={session.status}
          className={`inline-flex items-center gap-2 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-bold ${meta.pill}`}
        >
          <span className={`h-2 w-2 rounded-full bg-current ${meta.dot} ${meta.pulsing ? "animate-pulse" : ""}`} />
          {meta.label}
        </span>

        <div className="flex min-w-0 flex-1 items-center gap-3.5 overflow-x-auto text-[11px] text-white/45">
          <span className="whitespace-nowrap">
            <Key>repo</Key>
            <code className="text-white/75">{session.workContext.label}</code>
          </span>
          <span className="whitespace-nowrap">
            <Key>branch</Key>
            <code className="text-white/75">{session.featureBranch}</code>
          </span>
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <Key>rollback</Key>
            <code className="text-white/75">{session.rollbackTag}</code>
            <button
              onClick={copyTag}
              title={copied ? "Copied" : "Copy the rollback tag"}
              className="rounded px-1 py-0.5 text-white/30 hover:bg-white/10 hover:text-white/80"
            >
              <Copy size={11} />
            </button>
          </span>
          <span className="whitespace-nowrap">
            <Key>op</Key>
            <code className="text-white/75">{session.operationLabel}</code>
          </span>
        </div>

        <button
          data-testid="conflict-abandon"
          onClick={onAbandon}
          disabled={busy || ["resolved", "abandoned"].includes(session.status)}
          title="Restore the repo to its pre-reconciliation state using the rollback tag. Safe at any point — base is never left conflicted."
          className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-red-400/45 bg-red-500/15 px-2.5 py-1.5 text-[11px] text-red-300 hover:bg-red-500/25 disabled:opacity-40"
        >
          <Undo2 size={12} />
          Abandon &amp; roll back
        </button>
      </div>

      <div className="flex items-center gap-1.5 overflow-x-auto border-t border-white/10 px-3.5 py-1.5">
        <span className="mr-0.5 shrink-0 text-[9px] font-bold uppercase tracking-wider text-white/30">Decisions</span>
        {session.files.map((f) => {
          const resolved = f.resolvedContent !== undefined;
          const awaiting = !resolved && session.status === "awaiting-user" && (awaitingPath ? awaitingPath === f.path : false);
          const cls = resolved
            ? "text-emerald-300 border-emerald-400/25"
            : awaiting
              ? "text-amber-300 border-amber-400/45 bg-amber-500/15"
              : "text-white/45 border-white/10";
          return (
            <button
              key={f.path}
              onClick={() => onSelect(f.path)}
              data-testid="conflict-chip"
              className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded border bg-black/20 px-2 py-1 text-[10px] ${cls} ${
                selected === f.path ? "ring-1 ring-white/25" : ""
              }`}
            >
              <span>{resolved ? "✓" : awaiting ? "?" : "…"}</span>
              {baseName(f.path)}
              <span className="text-white/30">
                {resolved ? `by ${f.resolvedBy ?? "agent"}` : awaiting ? "awaiting" : f.waived ? "manual" : ""}
              </span>
            </button>
          );
        })}
        <span className="ml-auto shrink-0 pl-3 text-[10px] text-white/30">
          {done}/{session.files.length} files resolved · {open} open
        </span>
      </div>
    </div>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return <span className="mr-1.5 text-[9px] uppercase tracking-wider text-white/30">{children}</span>;
}
