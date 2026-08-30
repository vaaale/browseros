"use client";

import type { ConflictSession } from "@/lib/gitops/sessions/types";
import { baseName } from "./status";

// The conflicting-files rail (mockup `.files`). The amber left-border + amber
// filename on the file the agent is waiting on is one of the four
// awaiting-user surfaces (D6 — pill, banner, this row, the chat card).

interface Props {
  session: ConflictSession;
  selected: string | undefined;
  onSelect: (path: string) => void;
}

export function ConflictFileList({ session, selected, onSelect }: Props) {
  const awaitingPath = session.pendingDecision?.path;

  return (
    <div className="w-[230px] shrink-0 overflow-y-auto border-r border-white/10 bg-black/20">
      <div className="flex items-center gap-1.5 px-3 pb-1.5 pt-2 text-[9px] font-bold uppercase tracking-wider text-white/30">
        Conflicting files
        <span className="ml-auto text-white/45">{session.files.length}</span>
      </div>
      {session.files.length === 0 && (
        <p className="px-3 py-2 text-[11px] italic text-white/30">No conflicting files were captured.</p>
      )}
      {session.files.map((f) => {
        const resolved = f.resolvedContent !== undefined;
        const awaiting = !resolved && session.status === "awaiting-user" && awaitingPath === f.path;
        return (
          <button
            key={f.path}
            data-testid="conflict-file-row"
            onClick={() => onSelect(f.path)}
            className={`flex w-full flex-col gap-1 border-l-2 px-3 py-2 text-left hover:bg-white/[0.04] ${
              selected === f.path ? "bg-white/[0.06]" : ""
            } ${awaiting ? "border-l-amber-400" : selected === f.path ? "border-l-sky-400" : "border-l-transparent"}`}
          >
            <div className={`truncate font-mono text-[11px] ${awaiting ? "text-amber-300" : "text-white/75"}`}>
              {baseName(f.path)}
            </div>
            <div className="flex items-center gap-1.5">
              <span className="rounded border border-white/10 bg-black/30 px-1.5 py-px text-[9px] uppercase tracking-wide text-white/45">
                {f.binary ? "binary" : f.marker}
              </span>
              <span
                className={`ml-auto rounded-full px-1.5 py-px text-[9px] font-bold ${
                  resolved ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"
                }`}
              >
                {resolved ? "resolved" : f.waived ? "manual" : "conflict"}
              </span>
            </div>
            <div className="truncate text-[9.5px] text-white/30">{f.path}</div>
          </button>
        );
      })}
    </div>
  );
}
