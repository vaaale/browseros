"use client";

import { useState } from "react";
import { Check, Pencil, Sparkles } from "lucide-react";
import type { ConflictSession } from "@/lib/gitops/sessions/types";
import type { ThreeWayFile } from "./useConflictSession";

// The per-file / per-hunk decision controls (FR-010, mockup `.decide`).
//
// Every button here posts the SAME answer the chat's decision card posts —
// one route, one code path (design §5.2). Which is why answering from the
// pane and answering from the chat are indistinguishable to the agent.

export type DecisionOptionId = "ours" | "theirs" | "keep-both" | "suggestion" | "manual";

interface Props {
  session: ConflictSession;
  file: ThreeWayFile | null;
  path: string;
  /** Only the file the agent actually parked on can be answered. */
  answerable: boolean;
  busy: boolean;
  onAnswer: (optionId: DecisionOptionId, manualText?: string) => void;
}

export function ConflictDecisionCard({ session, file, path, answerable, busy, onAnswer }: Props) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const decision = session.pendingDecision;
  const suggestion = decision?.path === path ? decision.suggestion : undefined;
  const disabled = busy || !answerable;

  const openEditor = () => {
    const seed =
      suggestion ??
      (file
        ? `${file.ours ?? ""}${(file.ours ?? "").endsWith("\n") || !file.ours ? "" : "\n"}${file.theirs ?? ""}`
        : "");
    setText(seed);
    setEditing(true);
  };

  return (
    <div className="flex flex-col gap-2 border-t border-white/10 px-2.5 py-2.5">
      {suggestion !== undefined && (
        <div className="flex flex-col gap-1.5 rounded-md border border-emerald-400/40 bg-emerald-500/12 px-2.5 py-2">
          <span className="flex items-center gap-1.5 text-[10px] font-bold text-emerald-300">
            <Sparkles size={11} /> Agent&rsquo;s suggested resolution
          </span>
          {suggestion && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-black/35 p-2 font-mono text-[10.5px] text-white/70">
              {suggestion}
            </pre>
          )}
          <button
            data-testid="conflict-decide-suggestion"
            disabled={disabled}
            onClick={() => onAnswer("suggestion")}
            className="inline-flex w-fit items-center gap-1.5 rounded-md border border-emerald-400/40 bg-emerald-500/15 px-2.5 py-1.5 text-[11px] font-semibold text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-40"
          >
            <Check size={12} /> Accept agent&rsquo;s suggestion
          </button>
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        <DecideButton
          testId="conflict-decide-ours"
          disabled={disabled}
          tone="ours"
          onClick={() => onAnswer("ours")}
          label={`Accept ours · ${session.baseBranch || session.snapshot.ours}`}
        />
        <DecideButton
          testId="conflict-decide-theirs"
          disabled={disabled}
          tone="theirs"
          onClick={() => onAnswer("theirs")}
          label={`Accept theirs · ${session.featureBranch || session.snapshot.theirs}`}
        />
        <DecideButton
          testId="conflict-decide-both"
          disabled={disabled}
          tone="both"
          onClick={() => onAnswer("keep-both")}
          label="Keep both"
        />
        <button
          data-testid="conflict-decide-edit"
          disabled={disabled || file?.binary}
          onClick={openEditor}
          className="inline-flex items-center gap-1.5 rounded-md border border-white/15 bg-black/25 px-2.5 py-1.5 text-[11px] text-white/50 hover:bg-white/[0.06] disabled:opacity-40"
        >
          <Pencil size={11} /> Edit manually
        </button>
      </div>

      {!answerable && (
        <p className="text-[10.5px] italic text-white/30">
          {session.status === "awaiting-user"
            ? "The agent is waiting on a different file — select the amber one to answer."
            : "The agent is working. These controls unlock when it asks you to decide."}
        </p>
      )}

      {editing && (
        <>
          <textarea
            data-testid="conflict-edit-box"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="min-h-[120px] w-full resize-y rounded-md border border-white/15 bg-black/50 p-2 font-mono text-[11px] text-white/80 outline-none focus:border-sky-400/50"
          />
          <div className="flex gap-1.5">
            <button
              data-testid="conflict-save-edit"
              disabled={disabled}
              onClick={() => {
                setEditing(false);
                onAnswer("manual", text);
              }}
              className="rounded-md border border-emerald-400/40 bg-emerald-500/15 px-3 py-1.5 text-[11px] font-semibold text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-40"
            >
              Save edit
            </button>
            <button
              onClick={() => setEditing(false)}
              className="rounded-md border border-white/15 px-3 py-1.5 text-[11px] text-white/50 hover:bg-white/[0.06]"
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function DecideButton({
  label,
  tone,
  disabled,
  onClick,
  testId,
}: {
  label: string;
  tone: "ours" | "theirs" | "both";
  disabled: boolean;
  onClick: () => void;
  testId: string;
}) {
  const cls =
    tone === "ours"
      ? "border-red-400/35 text-red-300"
      : tone === "theirs"
        ? "border-sky-400/35 text-sky-300"
        : "border-amber-400/45 text-amber-300";
  return (
    <button
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md border bg-black/25 px-2.5 py-1.5 text-[11px] hover:bg-white/[0.06] disabled:opacity-40 ${cls}`}
    >
      {label}
    </button>
  );
}
