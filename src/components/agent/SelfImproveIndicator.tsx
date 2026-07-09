"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, Sparkles, AlertTriangle } from "lucide-react";

// Small non-blocking status pill for the async self_improve pass. Polls the
// per-conversation status and shows "Improving…" while it runs, then a transient
// "Self-improved" (or failure) so the user knows the system learned from their
// feedback without ever being blocked. Mounted with key={conversationId}, so it
// starts fresh per conversation.

interface Status {
  state: "running" | "done" | "error";
  startedAt: number;
  finishedAt?: number;
  summary?: string;
  error?: string;
}

const DONE_VISIBLE_MS = 20_000;
const ERROR_VISIBLE_MS = 30_000;

export function SelfImproveIndicator({ conversationId }: { conversationId?: string }) {
  const [running, setRunning] = useState(false);
  const [justFinished, setJustFinished] = useState<null | { kind: "done" | "error"; text?: string }>(null);
  const prevState = useRef<string | null>(null);

  useEffect(() => {
    if (!conversationId) return;
    let alive = true;
    const poll = async () => {
      try {
        const d = await fetch(`/api/assistant/self-improve?conversationId=${encodeURIComponent(conversationId)}`).then((r) => r.json());
        if (!alive) return;
        const s = (d.status as Status | null) ?? null;
        const prev = prevState.current;
        prevState.current = s?.state ?? null;
        setRunning(s?.state === "running");
        // Show the terminal pill only on a running → done/error transition (so a
        // stale "done" from before mount never flashes).
        if (prev === "running" && s && s.state !== "running") {
          setJustFinished(s.state === "error" ? { kind: "error", text: s.error } : { kind: "done", text: s.summary });
        }
      } catch {
        /* ignore transient poll errors */
      }
    };
    void poll();
    const id = setInterval(() => void poll(), 4000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [conversationId]);

  // Auto-hide the terminal pill after a delay (timer callback — no setState in the
  // effect body).
  useEffect(() => {
    if (!justFinished) return;
    const ms = justFinished.kind === "error" ? ERROR_VISIBLE_MS : DONE_VISIBLE_MS;
    const t = setTimeout(() => setJustFinished(null), ms);
    return () => clearTimeout(t);
  }, [justFinished]);

  if (running) {
    return (
      <Pill className="border-amber-400/30 bg-amber-400/15 text-amber-100">
        <Loader2 size={11} className="animate-spin" /> Improving…
      </Pill>
    );
  }
  if (justFinished?.kind === "error") {
    return (
      <Pill className="border-red-400/30 bg-red-400/15 text-red-100" title={justFinished.text}>
        <AlertTriangle size={11} /> Self-improve failed
      </Pill>
    );
  }
  if (justFinished?.kind === "done") {
    return (
      <Pill className="border-emerald-400/30 bg-emerald-400/15 text-emerald-100" title={justFinished.text}>
        <Sparkles size={11} /> Self-improved
      </Pill>
    );
  }
  return null;
}

function Pill({ children, className, title }: { children: ReactNode; className: string; title?: string }) {
  return (
    <div
      title={title}
      className={`pointer-events-auto flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] shadow ${className}`}
    >
      {children}
    </div>
  );
}
