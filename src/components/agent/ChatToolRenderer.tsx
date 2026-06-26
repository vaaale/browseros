"use client";

import { useEffect, useState } from "react";
import { useCopilotAction, type CatchAllActionRenderProps } from "@copilotkit/react-core";
import { ChevronDown, ChevronRight, Wrench } from "lucide-react";
import { parseMcpUi } from "@/lib/mcp/ui";
import { parseNested, type NestedEvent } from "@/lib/agent/nested-events";

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

// A single collapsible event card. Expanded on arrival; auto-collapses a few
// seconds after the event completes so only its heading remains visible.
function EventCard({
  name,
  status,
  args,
  result,
}: {
  name: string;
  status: string;
  args: unknown;
  result: unknown;
}) {
  const [expanded, setExpanded] = useState(true);
  const busy = status !== "complete";

  useEffect(() => {
    if (status === "complete") {
      const t = setTimeout(() => setExpanded(false), 3000);
      return () => clearTimeout(t);
    }
  }, [status]);

  const argText = preview(args, 300);
  const resultStr = typeof result === "string" ? result : "";
  const mcpUi = status === "complete" ? parseMcpUi(resultStr) : null;
  const nested = status === "complete" ? parseNested(resultStr) : null;

  return (
    <div className="my-1 rounded-lg border border-white/10 bg-black/30 text-xs">
      <button onClick={() => setExpanded((e) => !e)} className="flex w-full items-center gap-2 px-2 py-1.5 text-left">
        {expanded ? <ChevronDown size={12} className="text-white/40" /> : <ChevronRight size={12} className="text-white/40" />}
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${busy ? "animate-pulse bg-amber-400" : "bg-emerald-400"}`} />
        <Wrench size={12} className="shrink-0 text-white/50" />
        <span className="truncate font-mono font-medium text-white/85">{name}</span>
        <span className="ml-auto shrink-0 text-white/40">{busy ? status : "done"}</span>
      </button>

      {expanded && (
        <div className="px-2 pb-2">
          {argText && argText !== "{}" && (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words text-[11px] text-white/55">{argText}</pre>
          )}
          {nested ? (
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

// Renders a delegated sub-agent's events nested under the delegation card.
function NestedEvents({ events, output }: { events: NestedEvent[]; output: string }) {
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
      </div>
      {output && <pre className="mt-1 whitespace-pre-wrap break-words text-[11px] text-white/70">{output}</pre>}
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
