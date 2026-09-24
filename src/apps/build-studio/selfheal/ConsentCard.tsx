"use client";

import { useState } from "react";
import { ScopeClassBadge } from "./ScopeClassBadge";
import type { HealingCase } from "@/lib/self-heal/types";

// The class-b / class-c action card (031-self-healing FR-010/FR-011/FR-022c,
// mockup.html §2 card 2).
//
// Classes b and c are the only ones BOS applies in place — a skill body or a
// workflow definition, not source code — so there is no preview to promote
// afterwards. This card IS the checkpoint, which is why it renders the literal
// before/after text rather than a summary of it: approving something you can't
// read is not consent.

const BTN = "rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors disabled:opacity-40";
const BTN_PRIMARY = `${BTN} border border-violet-500/40 bg-violet-500/20 text-violet-200 hover:bg-violet-500/30`;
const BTN_GHOST = `${BTN} border border-white/15 bg-white/5 text-white/70 hover:bg-white/10`;

export function ConsentCard({
  record,
  busy,
  onApprove,
  onDismiss,
}: {
  record: HealingCase;
  busy?: boolean;
  onApprove: () => void;
  onDismiss: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const edit = record.proposedEdit;
  const escalatable = record.scopeClass === "e" || record.scopeClass === "d-bis";

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-white/10 bg-white/[0.03] p-3" data-testid="self-heal-consent-card">
      <div className="flex items-center gap-2">
        <ScopeClassBadge scopeClass={record.scopeClass} />
        <span className="text-xs font-semibold text-white">
          {escalatable ? "Ready to start — needs your go-ahead" : edit ? "Proposed edit" : "Needs your review"}
        </span>
      </div>

      {escalatable ? (
        <p className="text-[11px] leading-snug text-white/60">
          Autonomous implement is switched off, so this diagnosed fix is waiting for you. Approving it runs the full
          Build Studio pipeline and builds a preview — you still promote (or discard) it yourself at the end.
        </p>
      ) : edit ? (
        <>
          <p className="text-[11px] text-white/60">
            {edit.artifactType === "skill" ? "Skill" : "Workflow definition"}{" "}
            <code className="rounded bg-violet-500/10 px-1 py-0.5 font-mono text-[10px] text-violet-200">{edit.target}</code>
          </p>
          {edit.rationale ? <p className="text-[11px] leading-snug text-white/50">{edit.rationale}</p> : null}
          <div className="rounded-md border border-white/10 bg-black/40 p-2 font-mono text-[10px] leading-relaxed">
            <pre className={`block whitespace-pre-wrap rounded bg-red-400/10 px-1 text-red-300 ${expanded ? "" : "max-h-24 overflow-hidden"}`}>
              {edit.before
                .split("\n")
                .map((l) => `- ${l}`)
                .join("\n")}
            </pre>
            <pre className={`mt-1 block whitespace-pre-wrap rounded bg-emerald-400/10 px-1 text-emerald-300 ${expanded ? "" : "max-h-24 overflow-hidden"}`}>
              {edit.after
                .split("\n")
                .map((l) => `+ ${l}`)
                .join("\n")}
            </pre>
          </div>
          <button onClick={() => setExpanded((v) => !v)} className="self-start text-[10px] text-white/40 hover:text-white/70">
            {expanded ? "Show less" : "Show full diff"}
          </button>
        </>
      ) : (
        <p className="text-[11px] leading-snug text-white/60">
          The Diagnostician did not propose a concrete edit for this case — read the report below and decide what to do.
          Nothing will be changed unless you approve something.
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          className={BTN_PRIMARY}
          data-testid="self-heal-approve"
          disabled={busy || (!escalatable && !edit)}
          onClick={onApprove}
        >
          {escalatable ? "Start the fix" : "Approve edit"}
        </button>
        <button className={BTN_GHOST} data-testid="self-heal-dismiss" disabled={busy} onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
