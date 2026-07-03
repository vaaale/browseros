"use client";

import { useEffect } from "react";
import { useCopilotAction, type CatchAllActionRenderProps } from "@copilotkit/react-core";
import { ChevronDown, ChevronRight, Wrench, Loader2, Braces } from "lucide-react";
import { parseMcpUi } from "@/lib/mcp/ui";
import { parseNested, type NestedEvent } from "@/lib/agent/nested-events";
import { useDelegation } from "@/lib/agent/subagent-events";
import { registerCard, toggleCard, useCardOpen, useCardScope } from "@/lib/agent/card-collapse";

function formatFull(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function McpUiView({ html, url }: { html?: string; url?: string }) {
  return (
    <iframe
      {...(html ? { srcDoc: html } : { src: url })}
      sandbox="allow-scripts allow-forms allow-popups"
      className="mt-1 h-72 w-full rounded-md border border-white/10 bg-white"
      title="MCP app"
    />
  );
}

function NestedEvents({ events, output, running }: { events: NestedEvent[]; output: string; running?: boolean }) {
  return (
    <div className="mt-1 border-t border-white/10 pt-1">
      <div className="ml-2 border-l border-white/10 pl-2">
        {events.map((e, i) => (
          <div key={i} className="my-0.5 flex items-center gap-1.5 text-[11px] text-white/55">
            <span className="h-1 w-1 rounded-full bg-emerald-400/70" />
            <span className="font-mono">{e.tool}</span>
            {e.input != null ? <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-white/35">{formatFull(e.input)}</span> : null}
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

// A single collapsible event card. It joins the shared accordion: expanded when
// it is the newest card, and collapsed as soon as a newer card or the agent's
// answer is inserted. The header is a button so clicking it reliably toggles the
// card (the old native <details> approach didn't toggle once `open` was driven by
// the store).
function EventCard({ name, status, args, result }: { name: string; status: string; args: unknown; result: unknown }) {
  // No stable tool-call id is available from the catch-all render props, so the
  // id is content-derived. It changes while args stream in (keeping the live card
  // the newest/open one) and stabilizes once the call completes.
  const cardId = `${name}:${formatFull(args).slice(0, 120)}`;
  const scope = useCardScope();
  const open = useCardOpen(scope, cardId);
  const busy = status !== "complete";

  // Newest card opens (and collapses the previous). Idempotent per id.
  useEffect(() => {
    registerCard(scope, cardId);
  }, [scope, cardId]);

  // Live sub-agent events for delegation cards (streamed before completion).
  const liveKey = name === "delegateToSubAgent" ? String((args as { task?: string })?.task ?? "") : "";
  const live = useDelegation(liveKey);

  const argText = formatFull(args);
  const resultStr = typeof result === "string" ? result : "";
  const resultText = formatFull(result);
  const mcpUi = status === "complete" ? parseMcpUi(resultStr) : null;
  const nested = status === "complete" ? parseNested(resultStr) : null;
  const liveEvents = live && (live.events.length > 0 || !live.done) ? live : null;

  return (
    <div className="my-1 rounded-lg border border-white/10 bg-black/30 text-xs">
      <button
        type="button"
        // Toggle on pointerdown (not click): CopilotKit remounts the wildcard
        // tool-call render whenever the chat re-renders (e.g. while the agent
        // (re)connects after a conversation is restored), which replaces this
        // button between mousedown and mouseup so a `click` never completes. A
        // pointerdown is a single event that lands on whatever button is mounted
        // at that instant. keydown keeps the header keyboard-operable.
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
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${busy ? "animate-pulse bg-amber-400" : "bg-emerald-400"}`} />
        <Wrench size={12} className="shrink-0 text-white/50" />
        <span className="truncate font-mono font-medium text-white/85">{name}</span>
        <span className="ml-auto shrink-0 text-white/40">{busy ? status : "done"}</span>
      </button>

      <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
        <div className={`min-h-0 overflow-hidden transition-opacity duration-150 ease-out ${open ? "opacity-100" : "opacity-0"}`}>
          <div className="max-h-64 overflow-auto overscroll-contain px-2 pb-2">
            {argText && argText !== "{}" && (
              <section>
                <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-white/35">Request</div>
                <pre className="overflow-x-auto whitespace-pre-wrap break-words text-[11px] text-white/55">{argText}</pre>
              </section>
            )}
            {liveEvents ? (
              <section className={argText && argText !== "{}" ? "mt-1" : undefined}>
                <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-white/35">Response</div>
                <NestedEvents events={liveEvents.events} output={liveEvents.done ? liveEvents.output ?? "" : ""} running={!liveEvents.done} />
              </section>
            ) : nested ? (
              <section className={argText && argText !== "{}" ? "mt-1" : undefined}>
                <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-white/35">Response</div>
                <NestedEvents events={nested.events} output={nested.output} />
              </section>
            ) : mcpUi ? (
              <section className={argText && argText !== "{}" ? "mt-1" : undefined}>
                <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-white/35">Response</div>
                <McpUiView html={mcpUi.html} url={mcpUi.url} />
              </section>
            ) : (
              status === "complete" &&
              result !== undefined && (
                <section className={argText && argText !== "{}" ? "mt-1" : undefined}>
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

// CopilotKit's BuiltInAgent injects AG-UI shared-state tools into every run. Their
// effect is the synchronized session state (shown live in the Info panel's State
// tab), so a full Request/Response card in the transcript is just noise — render a
// compact one-line note instead.
const STATE_SYNC_TOOLS = new Set(["AGUISendStateSnapshot", "AGUISendStateDelta"]);

function StateSyncNote({ status }: { status: string }) {
  const busy = status !== "complete";
  return (
    <div className="my-1 flex items-center gap-1.5 px-2 py-1 text-[11px] text-white/40">
      <Braces size={11} className="shrink-0 text-white/35" />
      <span>{busy ? "Updating session state…" : "Updated session state"}</span>
    </div>
  );
}

// Catch-all renderer: every tool/action call becomes a collapsible event card.
// The empty dependency array memoizes the action registration so the wildcard
// `render` keeps a STABLE identity across re-renders. CopilotKit mounts the
// wildcard render as a component type, so a fresh closure each render would
// REMOUNT every tool card on any chat re-render (e.g. while an agent run churns),
// which destroys the header button mid-click — the card could never be toggled.
export function ChatToolRenderer() {
  useCopilotAction(
    {
      name: "*",
      render: ({ name, status, args, result }: CatchAllActionRenderProps<[]>) =>
        STATE_SYNC_TOOLS.has(name) ? (
          <StateSyncNote status={status} />
        ) : (
          <EventCard name={name} status={status} args={args} result={result} />
        ),
    },
    [],
  );
  return null;
}
