"use client";

import { memo, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, Copy, Loader2 } from "lucide-react";
import { parseMcpUi } from "@/lib/mcp/ui";
import {
  argRows,
  childrenFromLive,
  detectOutputMode,
  nestedFromTerminal,
  type ChildCardData,
} from "./ToolCardSummary";
import {
  toggleInputRaw,
  toggleSection,
  useInputRaw,
  useSectionOpen,
  type ToolCardSection,
} from "./ToolCardSectionState";
import { ChatMarkdown } from "./ChatMarkdown";

// 045 US3 — the two independently-collapsible sections inside a tool-call card:
//   Input  — structured key–value rows (primary emphasized) with a raw-JSON toggle (FR-013)
//   Output — content-type rendered (mcp-ui / child cards / highlighted JSON / markdown) (FR-014)
// Each section's open state is card-local (ToolCardSectionState, ADR-2 option B) and
// defaults collapsed; the header accordion is the card's own concern (ToolCallCard).
//
// The Output section renders a delegation's children through the `renderChild` prop
// (the parent card passes itself) — NOT by importing ToolCallCard directly, which
// would be a circular import. The recursion is thus structural: the parent renders
// the same component for each child (FR-011).

function CopyButton({ text, label = "copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    // Mirrors the chat's own CodeBlock (MarkdownRenderers.tsx): clipboard can be
    // unavailable (e.g. a non-secure context) — that's an expected absence, not a
    // failure to hide, so the rejection is intentionally a no-op (existing pattern).
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => undefined,
    );
  };
  return (
    <button
      type="button"
      onClick={copy}
      className="flex items-center gap-1 rounded px-1 text-[10px] uppercase tracking-wide text-white/35 hover:text-white/70"
    >
      {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
      {copied ? "copied" : label}
    </button>
  );
}

/** A single independently-collapsible section (Input / Output). The header is a
 *  flex of sibling buttons (collapse toggle + optional trailing control) so no
 *  interactive element nests inside another. */
function Section({
  callId,
  section,
  label,
  trailing,
  right,
  children,
}: {
  callId: string;
  section: ToolCardSection;
  label: string;
  trailing?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
}) {
  const open = useSectionOpen(callId, section);
  return (
    <div data-testid={`tool-card-${section === "input" ? "input" : "output"}`}>
      <div className="flex items-center gap-1 px-1 py-1">
        <button
          type="button"
          onClick={() => toggleSection(callId, section)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 cursor-pointer select-none items-center gap-1.5 text-left text-white/55 hover:text-white/80"
        >
          {open ? <ChevronDown size={10} className="shrink-0 text-white/35" /> : <ChevronRight size={10} className="shrink-0 text-white/35" />}
          <span className="text-[10px] font-semibold uppercase tracking-wide text-white/35">{label}</span>
        </button>
        {trailing}
        <span className="shrink-0">{right}</span>
      </div>
      {open && <div className="max-h-64 overflow-auto overscroll-contain pl-4 pr-1 pb-1">{children}</div>}
    </div>
  );
}

function renderValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const InputSection = memo(function InputSection({ callId, name, args }: { callId: string; name: string; args: string }) {
  const rows = useMemo(() => argRows(name, args), [name, args]);
  const raw = useInputRaw(callId);
  const rawJson = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(args), null, 2);
    } catch {
      return args;
    }
  }, [args]);
  if (rows.length === 0 && !args) return null;
  return (
    <Section
      callId={callId}
      section="input"
      label="Input"
      trailing={
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            toggleInputRaw(callId);
          }}
          className="shrink-0 rounded border border-white/10 px-1 text-[9px] uppercase tracking-wide text-white/35 hover:border-white/20 hover:text-white/60"
        >
          {raw ? "structured" : "raw"}
        </button>
      }
    >
      {raw ? (
        <pre className="whitespace-pre-wrap break-words text-[11px] text-white/55">{rawJson}</pre>
      ) : (
        <div className="space-y-0.5">
          {rows.map((r) => (
            <div key={r.key} className={`flex gap-2 py-0.5 ${r.primary ? "" : ""}`}>
              <span className="shrink-0 text-white/40">{r.key}</span>
              <span className={`min-w-0 break-words ${r.primary ? "font-medium text-white" : "text-white/70"}`}>{renderValue(r.value)}</span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
});

export const OutputSection = memo(function OutputSection({
  callId,
  status,
  result,
  progress,
  renderChild,
}: {
  callId: string;
  status: "running" | "done" | "cancelled";
  result: string;
  progress: unknown[];
  renderChild: (child: ChildCardData) => ReactNode;
}) {
  const running = status === "running";
  const liveChildren = useMemo(
    () => (running ? childrenFromLive(progress, callId) : []),
    [running, progress, callId],
  );
  const isDelegation = running ? liveChildren.length > 0 : result ? detectOutputMode(result) === "nested" : false;

  // Header right side: content-type label + (json) copy.
  const mode = !running && result ? detectOutputMode(result) : undefined;
  const right =
    running && isDelegation ? (
      <span className="flex items-center gap-1 text-[10px] text-amber-400/70">
        <Loader2 size={10} className="animate-spin" />
        {liveChildren.filter((c) => c.status !== "running").length} of {liveChildren.length} nested
      </span>
    ) : running ? (
      <span className="flex items-center gap-1 text-[10px] text-amber-400/70">
        <Loader2 size={10} className="animate-spin" /> live
      </span>
    ) : mode ? (
      <span className="flex items-center gap-1.5">
        <span className="text-[10px] text-white/30">{mode === "mcp-ui" ? "app" : mode}</span>
        {mode === "json" && <CopyButton text={result} />}
      </span>
    ) : null;

  let body: ReactNode = null;
  if (running) {
    if (isDelegation) {
      body = (
        <div className="ml-1 space-y-1 border-l border-white/10 pl-2">
          {liveChildren.map((c) => (
            <Child key={c.callId} child={c} renderChild={renderChild} />
          ))}
        </div>
      );
    } else {
      body = (
        <div className="flex items-center gap-1.5 text-[11px] text-white/40">
          <Loader2 size={10} className="animate-spin" /> running…
        </div>
      );
    }
  } else if (result) {
    const m = detectOutputMode(result);
    if (m === "mcp-ui") {
      const ui = parseMcpUi(result);
      body = (
        <iframe
          {...(ui?.html ? { srcDoc: ui.html } : { src: ui?.url })}
          sandbox="allow-scripts allow-forms allow-popups"
          className="mt-1 h-72 w-full rounded-md border border-white/10 bg-white"
          title="MCP app"
        />
      );
    } else if (m === "nested") {
      const nested = nestedFromTerminal(result, callId)!;
      body = (
        <div className="space-y-1.5">
          <div className="ml-1 space-y-1 border-l border-white/10 pl-2">
            {nested.children.map((c) => (
              <Child key={c.callId} child={c} renderChild={renderChild} />
            ))}
          </div>
          {nested.output && <div className="mt-1 text-[11px] leading-relaxed text-white/60"><ChatMarkdown content={nested.output} /></div>}
        </div>
      );
    } else if (m === "json") {
      body = <ChatMarkdown content={`\`\`\`json\n${safePrettyJson(result)}\n\`\`\``} />;
    } else {
      body = <ChatMarkdown content={result} />;
    }
  }

  return (
    <Section callId={callId} section="output" label="Output" right={right}>
      {body}
    </Section>
  );
});

/** A single (recursive) child card. */
function Child({ child, renderChild }: { child: ChildCardData; renderChild: (c: ChildCardData) => ReactNode }) {
  return <>{renderChild(child)}</>;
}

function safePrettyJson(result: string): string {
  try {
    return JSON.stringify(JSON.parse(result), null, 2);
  } catch {
    return result;
  }
}
