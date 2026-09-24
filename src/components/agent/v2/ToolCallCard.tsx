"use client";

import { memo, useEffect, useMemo } from "react";
import { Ban, ChevronDown, ChevronRight, Wrench } from "lucide-react";
import { registerCard, toggleCard, useCardOpen, useCardScope } from "@/lib/agent/card-collapse";
import { summarizeToolCall, type ChildCardData } from "./ToolCardSummary";
import { toggleSection, useSectionOpen } from "./ToolCardSectionState";
import { InputSection, OutputSection } from "./ToolCardSections";

// 045 US3 — a SINGLE recursive tool-call card, rendered identically at every
// nesting depth (FR-011). A collapsed header (action summary + status dot,
// FR-012) expands to two INDEPENDENTLY collapsible sections — Input (FR-013) and
// Output (FR-014) — and a delegation's Output is a list of CHILD ToolCallCards
// (the same component, recursed; FR-006/FR-016 for the live in-flight case).
//
// Collapse-state model (ADR-2 option B): a TOP-LEVEL card's header uses the shared
// card-collapse accordion (scoped, also shared with the reasoning cards) exactly as
// before; a NESTED child's header uses the card-local section state so multiple
// cards (parent + children) can be open at once (the mockup's binding contract).
// The Input/Output sections ALWAYS use the card-local state.

export interface ToolCardData {
  callId: string;
  name: string;
  args: string;
  status: "running" | "done" | "cancelled";
  result?: string;
  /** Live nested progress (tool_progress events) while running. */
  progress?: unknown[];
}

function StatusDot({ status }: { status: ToolCardData["status"] }) {
  if (status === "cancelled") return <Ban size={12} className="shrink-0 text-white/40" />;
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${status === "running" ? "animate-pulse bg-amber-400" : "bg-emerald-400"}`} />;
}

export const ToolCallCard = memo(function ToolCallCard({ call, nested = false }: { call: ToolCardData; nested?: boolean }) {
  const scope = useCardScope();
  const cardId = `tool:${call.callId}`;
  const busy = call.status === "running";
  const cancelled = call.status === "cancelled";

  // Header open state: top-level cards use the shared accordion (unchanged);
  // nested children use card-local state (independent, so parent + children can
  // be open together — the mockup's recursive contract).
  const sharedOpen = useCardOpen(scope, cardId);
  const localHeaderOpen = useSectionOpen(call.callId, "header");
  const open = nested ? localHeaderOpen : sharedOpen;

  useEffect(() => {
    if (!nested) registerCard(scope, cardId);
  }, [nested, scope, cardId]);

  const onToggle = () => {
    if (nested) toggleSection(call.callId, "header");
    else toggleCard(scope, cardId);
  };

  const summary = useMemo(() => summarizeToolCall(call.name, call.args), [call.name, call.args]);
  const resultText = call.result ?? "";
  const progress = call.progress ?? [];
  // Empty/null result → no Output section (spec edge case); the recursion holds
  // for every other state.
  const showOutput = busy || resultText !== "";

  const renderChild = (child: ChildCardData) => <ToolCallCard call={child} nested />;

  return (
    <div
      className={`${nested ? "my-0.5" : "my-1"} rounded-lg border border-white/10 bg-black/30 text-xs`}
      data-testid="tool-card"
      data-tool={call.name}
      data-status={call.status}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-label={call.name}
        aria-expanded={open}
        className={`flex w-full cursor-pointer select-none items-center gap-2 rounded-t-lg px-2 text-left ${nested ? "py-1" : "py-1.5"} hover:bg-white/[0.02]`}
      >
        {open ? <ChevronDown size={12} className="shrink-0 text-white/40" /> : <ChevronRight size={12} className="shrink-0 text-white/40" />}
        <StatusDot status={call.status} />
        <Wrench size={12} className="shrink-0 text-white/50" />
        <span className="min-w-0 truncate font-medium text-white/85">
          {summary.title}
          {summary.detail && <span className="font-normal text-white/45"> · {summary.detail}</span>}
        </span>
        <span className={`ml-auto shrink-0 ${cancelled ? "text-white/35" : busy ? "text-amber-400/80" : "text-white/40"}`}>
          {cancelled ? "cancelled" : busy ? "running" : "done"}
        </span>
      </button>

      <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
        <div className={`min-h-0 overflow-hidden transition-opacity duration-150 ease-out ${open ? "opacity-100" : "invisible opacity-0"}`}>
          <div className="space-y-1 px-2 pb-2">
            <InputSection callId={call.callId} name={call.name} args={call.args} />
            {showOutput ? (
              <OutputSection callId={call.callId} status={call.status} result={resultText} progress={progress} renderChild={renderChild} />
            ) : (
              <div className="pl-4 text-[11px] italic text-white/30">No output</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
