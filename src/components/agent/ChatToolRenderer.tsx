"use client";

import { useEffect } from "react";
import { useCopilotAction, type CatchAllActionRenderProps } from "@copilotkit/react-core";
import { ChevronDown, ChevronRight, Wrench, Loader2 } from "lucide-react";
import { parseMcpUi } from "@/lib/mcp/ui";
import { parseNested, type NestedEvent } from "@/lib/agent/nested-events";
import { useDelegation } from "@/lib/agent/subagent-events";
import { registerCard, toggleCard, useCardOpen } from "@/lib/agent/card-collapse";

function preview(value: unknown, max = 600): string {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > max ? `${text.slice(0, max)}…` : text;
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
            {e.input != null ? <span className="truncate text-white/35">{preview(e.input, 80)}</span> : null}
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
  const cardId = `${name}:${preview(args, 120)}`;
  const open = useCardOpen(cardId);
  const busy = status !== "complete";

  // Newest card opens (and collapses the previous). Idempotent per id.
  useEffect(() => {
    registerCard(cardId);
  }, [cardId]);

  // Live sub-agent events for delegation cards (streamed before completion).
  const liveKey = name === "delegateToSubAgent" ? String((args as { task?: string })?.task ?? "") : "";
  const live = useDelegation(liveKey);

  const argText = preview(args, 300);
  const resultStr = typeof result === "string" ? result : "";
  const mcpUi = status === "complete" ? parseMcpUi(resultStr) : null;
  const nested = status === "complete" ? parseNested(resultStr) : null;
  const liveEvents = live && (live.events.length > 0 || !live.done) ? live : null;

  return (
    <div className="my-1 rounded-lg border border-white/10 bg-black/30 text-xs">
      <button
        type="button"
        onClick={() => toggleCard(cardId)}
        aria-expanded={open}
        className="flex w-full cursor-pointer select-none items-center gap-2 px-2 py-1.5 text-left"
      >
        {open ? <ChevronDown size={12} className="shrink-0 text-white/40" /> : <ChevronRight size={12} className="shrink-0 text-white/40" />}
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${busy ? "animate-pulse bg-amber-400" : "bg-emerald-400"}`} />
        <Wrench size={12} className="shrink-0 text-white/50" />
        <span className="truncate font-mono font-medium text-white/85">{name}</span>
        <span className="ml-auto shrink-0 text-white/40">{busy ? status : "done"}</span>
      </button>

      {open && (
        <div className="px-2 pb-2">
          {argText && argText !== "{}" && (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words text-[11px] text-white/55">{argText}</pre>
          )}
          {liveEvents ? (
            <NestedEvents events={liveEvents.events} output={liveEvents.done ? liveEvents.output ?? "" : ""} running={!liveEvents.done} />
          ) : nested ? (
            <NestedEvents events={nested.events} output={nested.output} />
          ) : mcpUi ? (
            <McpUiView html={mcpUi.html} url={mcpUi.url} />
          ) : (
            status === "complete" &&
            result !== undefined && (
              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words border-t border-white/10 pt-1 text-[11px] text-white/70">
                {preview(result)}
              </pre>
            )
          )}
        </div>
      )}
    </div>
  );
}

// Catch-all renderer: every tool/action call becomes a collapsible event card.
export function ChatToolRenderer() {
  useCopilotAction({
    name: "*",
    render: ({ name, status, args, result }: CatchAllActionRenderProps<[]>) => (
      <EventCard name={name} status={status} args={args} result={result} />
    ),
  });
  return null;
}
