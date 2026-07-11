"use client";

import { useEffect } from "react";
import { ChevronDown, ChevronRight, Wrench, Loader2, Ban } from "lucide-react";
import { parseMcpUi } from "@/lib/mcp/ui";
import { parseNested, type NestedEvent } from "@/lib/agent/nested-events";
import { registerCard, toggleCard, useCardOpen, useCardScope } from "@/lib/agent/card-collapse";

// v2 collapsible tool-call card. Same look/behavior as the CopilotKit-era
// EventCard, but driven by plain data (v2 has STABLE callIds and streams
// nested progress as run events — no delegation-store side channel needed).

export interface ToolCardData {
  callId: string;
  name: string;
  args: string;
  status: "running" | "done" | "cancelled";
  result?: string;
  /** Live nested progress (tool_progress events) while running. */
  progress?: unknown[];
}

function pretty(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2);
}

function toNestedEvents(progress: unknown[]): NestedEvent[] {
  return progress
    .map((p) => p as { tool?: string; input?: unknown; type?: string; stepId?: string })
    .map((p) => ({ tool: p.tool ?? p.type ?? "event", input: p.input ?? p.stepId }))
    .filter((e) => e.tool !== "event" || e.input != null);
}

function NestedEventList({ events, output, running }: { events: NestedEvent[]; output: string; running?: boolean }) {
  return (
    <div className="mt-1 border-t border-white/10 pt-1">
      <div className="ml-2 border-l border-white/10 pl-2">
        {events.map((e, i) => (
          <div key={i} className="my-0.5 flex items-center gap-1.5 text-[11px] text-white/55">
            <span className="h-1 w-1 rounded-full bg-emerald-400/70" />
            <span className="font-mono">{e.tool}</span>
            {e.input != null ? (
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-white/35">{pretty(e.input)}</span>
            ) : null}
          </div>
        ))}
        {running && (
          <div className="my-0.5 flex items-center gap-1.5 text-[11px] text-white/40">
            <Loader2 size={10} className="animate-spin" /> running…
          </div>
        )}
      </div>
      {output && <pre className="mt-1 whitespace-pre-wrap break-words text-[11px] text-white/70">{output}</pre>}
    </div>
  );
}

export function ToolCallCard({ call }: { call: ToolCardData }) {
  const cardId = `tool:${call.callId}`;
  const scope = useCardScope();
  const open = useCardOpen(scope, cardId);
  const busy = call.status === "running";
  const cancelled = call.status === "cancelled";

  useEffect(() => {
    registerCard(scope, cardId);
  }, [scope, cardId]);

  const argText = pretty(call.args);
  const showArgs = argText && argText !== "{}";
  const resultText = call.result ?? "";
  const mcpUi = call.status === "done" ? parseMcpUi(resultText) : null;
  const nested = call.status === "done" ? parseNested(resultText) : null;
  const liveNested = busy && call.progress?.length ? toNestedEvents(call.progress) : null;

  return (
    <div className="my-1 rounded-lg border border-white/10 bg-black/30 text-xs" data-testid="tool-card" data-tool={call.name}>
      <button
        type="button"
        onPointerDown={() => toggleCard(scope, cardId)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleCard(scope, cardId);
          }
        }}
        aria-expanded={open}
        className="flex w-full cursor-pointer select-none items-center gap-2 px-2 py-1.5 text-left"
      >
        {open ? <ChevronDown size={12} className="shrink-0 text-white/40" /> : <ChevronRight size={12} className="shrink-0 text-white/40" />}
        {cancelled ? (
          <Ban size={12} className="shrink-0 text-white/40" />
        ) : (
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${busy ? "animate-pulse bg-amber-400" : "bg-emerald-400"}`} />
        )}
        <Wrench size={12} className="shrink-0 text-white/50" />
        <span className="truncate font-mono font-medium text-white/85">{call.name}</span>
        <span className="ml-auto shrink-0 text-white/40">{cancelled ? "cancelled" : busy ? "running" : "done"}</span>
      </button>

      <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
        <div className={`min-h-0 overflow-hidden transition-opacity duration-150 ease-out ${open ? "opacity-100" : "invisible opacity-0"}`}>
          <div className="max-h-64 overflow-auto overscroll-contain px-2 pb-2">
            {showArgs && (
              <section>
                <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-white/35">Request</div>
                <pre className="overflow-x-auto whitespace-pre-wrap break-words text-[11px] text-white/55">{argText}</pre>
              </section>
            )}
            {liveNested ? (
              <section className={showArgs ? "mt-1" : undefined}>
                <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-white/35">Response</div>
                <NestedEventList events={liveNested} output="" running />
              </section>
            ) : nested ? (
              <section className={showArgs ? "mt-1" : undefined}>
                <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-white/35">Response</div>
                <NestedEventList events={nested.events} output={nested.output} />
              </section>
            ) : mcpUi ? (
              <section className={showArgs ? "mt-1" : undefined}>
                <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-white/35">Response</div>
                <iframe
                  {...(mcpUi.html ? { srcDoc: mcpUi.html } : { src: mcpUi.url })}
                  sandbox="allow-scripts allow-forms allow-popups"
                  className="mt-1 h-72 w-full rounded-md border border-white/10 bg-white"
                  title="MCP app"
                />
              </section>
            ) : (
              call.status !== "running" &&
              resultText && (
                <section className={showArgs ? "mt-1" : undefined}>
                  <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-white/35">Response</div>
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words text-[11px] text-white/70">{resultText}</pre>
                </section>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
