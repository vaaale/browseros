"use client";

import { useEffect, useRef, useState } from "react";
import { useCopilotChatInternal } from "@copilotkit/react-core";
import { Loader2, Square } from "lucide-react";

// A continuous "the agent is working" pill WITH an always-available Stop button.
// CopilotKit's own Stop button (driven by isRunning) disappears between runs —
// notably while a client tool call is executing (e.g. a long agent_delegate) — so
// the chat can look frozen/crashed and there is no way to cancel. This stays
// visible whenever the agent is streaming OR a tool call is still awaiting its
// result, shows an elapsed timer (a climbing count reads as "alive"; an
// ever-growing one hints the run is stuck), and lets the user stop at any point.

interface AnyMsg {
  role?: string;
  toolCalls?: Array<{ id?: string }>;
  toolCallId?: string;
  content?: unknown;
}

/** True when some tool call has no matching tool result yet (a call in flight). */
function hasPendingToolCall(messages: AnyMsg[]): boolean {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const m of messages) {
    if (Array.isArray(m.toolCalls)) for (const c of m.toolCalls) if (c?.id) calls.add(c.id);
    if (typeof m.toolCallId === "string") results.add(m.toolCallId);
    if (Array.isArray(m.content)) {
      for (const p of m.content as Array<{ type?: string; toolCallId?: string }>) {
        if (p?.type === "tool-call" && p.toolCallId) calls.add(p.toolCallId);
        if (p?.type === "tool-result" && p.toolCallId) results.add(p.toolCallId);
      }
    }
  }
  for (const id of calls) if (!results.has(id)) return true;
  return false;
}

export function AgentActivityIndicator() {
  const { agent, isLoading, stopGeneration } = useCopilotChatInternal();
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const a = agent as
      | { messages?: AnyMsg[]; subscribe?: (h: { onMessagesChanged: () => void }) => { unsubscribe: () => void } }
      | undefined;
    if (!a?.subscribe) return;
    const compute = () => setPending(hasPendingToolCall(a.messages ?? []));
    compute();
    const sub = a.subscribe({ onMessagesChanged: compute });
    return () => sub.unsubscribe();
  }, [agent]);

  // Manual stop: aborting a run mid tool-call does NOT append a tool result, so
  // `pending` would stay true forever and pin the pill. Suppress it after a stop
  // until the next run begins (isLoading rising edge), or when the user resumes.
  const [stopped, setStopped] = useState(false);
  const prevLoadingRef = useRef(false);
  useEffect(() => {
    const loading = Boolean(isLoading);
    if (loading && !prevLoadingRef.current) setStopped(false);
    prevLoadingRef.current = loading;
  }, [isLoading]);

  const working = (Boolean(isLoading) || pending) && !stopped;

  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!working) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setElapsed(0);
    const start = Date.now();
    const id = setInterval(() => setElapsed(Math.round((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, [working]);

  if (!working) return null;

  const stop = () => {
    try {
      stopGeneration?.();
    } catch {
      /* best-effort */
    }
    setStopped(true);
  };

  return (
    <div className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-sky-400/30 bg-sky-400/15 py-0.5 pl-2 pr-1 text-[11px] text-sky-100 shadow">
      <Loader2 size={11} className="animate-spin" />
      <span>{elapsed >= 3 ? `Working ${elapsed}s` : "Working…"}</span>
      <button
        type="button"
        onClick={stop}
        title="Stop"
        aria-label="Stop the agent"
        className="ml-0.5 flex items-center justify-center rounded-full bg-white/10 p-1 text-sky-50 transition-colors hover:bg-red-500/70 hover:text-white"
      >
        <Square size={9} className="fill-current" />
      </button>
    </div>
  );
}
