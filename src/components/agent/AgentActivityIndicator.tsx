"use client";

import { useEffect, useRef, useState } from "react";
import { useCopilotChatInternal } from "@copilotkit/react-core";
import { Loader2 } from "lucide-react";

// A continuous "the agent is working" STATUS pill. It stays visible whenever
// the agent is streaming OR a client tool call is still awaiting its result and
// shows an elapsed timer (a climbing count reads as "alive"; an ever-growing
// one hints the run is stuck). Stopping lives in ONE place — the chat input's
// send/stop button (ChatInput.tsx) — which announces a stop via the
// "bos:agent-stop" event so this pill can dismiss itself for aborted turns
// whose tool calls never receive a result.

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
  const { agent, isLoading } = useCopilotChatInternal();
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

  // Manual stop (from the chat input's stop button): aborting a run whose tool
  // calls never started executing appends no tool result, so `pending` would
  // stay true forever and pin the pill. Suppress it after a stop until the next
  // run begins (isLoading rising edge).
  const [stopped, setStopped] = useState(false);
  const prevLoadingRef = useRef(false);
  useEffect(() => {
    const loading = Boolean(isLoading);
    if (loading && !prevLoadingRef.current) setStopped(false);
    prevLoadingRef.current = loading;
  }, [isLoading]);
  useEffect(() => {
    const onStop = () => setStopped(true);
    window.addEventListener("bos:agent-stop", onStop);
    return () => window.removeEventListener("bos:agent-stop", onStop);
  }, []);

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

  return (
    <div className="flex items-center gap-1.5 rounded-full border border-sky-400/30 bg-sky-400/15 px-2 py-0.5 text-[11px] text-sky-100 shadow">
      <Loader2 size={11} className="animate-spin" />
      <span>{elapsed >= 3 ? `Working ${elapsed}s` : "Working…"}</span>
    </div>
  );
}
