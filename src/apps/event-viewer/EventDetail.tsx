"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, AlertTriangle, Check, RotateCw, Inbox } from "lucide-react";
import { AppIcon } from "@/components/desktop/icons";
import { subscribeEventStream } from "@/components/desktop/subscribeEventStream";
import type { EventFullView } from "@/lib/events/types";
import { relTime, formatValue, MetaChip } from "./format";

// The generic (default) event detail view (FR-017) — always available, and
// the ONLY detail rendered inside the viewer: a resolved UI handler instead
// launches its owning app's window via launch() (design.md §3.5), so by
// construction this component only renders for the zero-UI-handler case.
export function EventDetail({ eventId, onBack }: { eventId: string; onBack: () => void }) {
  const [event, setEvent] = useState<EventFullView | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/events/${encodeURIComponent(eventId)}`);
      if (res.ok) {
        setEvent((await res.json()) as EventFullView);
      } else {
        setNotFound(true);
      }
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  useEffect(() => {
    const unsubscribe = subscribeEventStream((msg) => {
      if (msg.eventId === eventId) void load();
    });
    return unsubscribe;
  }, [eventId, load]);

  const header = (
    <div className="flex shrink-0 items-center gap-2 border-b border-white/10 bg-white/[0.03] px-3 py-2">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-white/60 transition-colors hover:bg-white/10 hover:text-white"
      >
        <ArrowLeft size={14} /> Back to events
      </button>
      <span className="ml-auto text-xs text-white/40">Event detail</span>
    </div>
  );

  if (notFound) {
    return (
      <div className="flex h-full flex-col">
        {header}
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <Inbox size={32} className="text-white/15" />
          <p className="text-xs text-white/40">This event no longer exists.</p>
        </div>
      </div>
    );
  }

  if (loading && !event) {
    return (
      <div className="flex h-full flex-col">
        {header}
        <div className="p-4 text-xs text-white/40">Loading…</div>
      </div>
    );
  }
  if (!event) return null;

  const entries = Object.entries(event.payload ?? {});

  return (
    <div className="flex h-full flex-col" data-testid="event-detail">
      {header}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="mb-4 flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/5 text-white/70">
            <AppIcon name={event.source.icon || "Bell"} size={22} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-white">{event.summary}</h2>
            <div className="mt-1 flex items-center gap-2 text-xs text-white/50">
              <span>{event.source.name}</span>
              <span className="text-white/25">·</span>
              {event.processing === "pending" ? (
                <span className="inline-flex items-center gap-1.5 text-white/50">
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/20 border-t-white/70" /> processing…
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-emerald-300">
                  <Check size={12} /> processed
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="mb-4 flex flex-wrap gap-1.5">
          <MetaChip k="type" v={event.type} />
          <MetaChip k="seq" v={String(event.sequence)} />
          <MetaChip k="id" v={event.id} />
          <MetaChip k="time" v={relTime(event.ts)} />
        </div>

        {event.processing === "pending" && event.handlersTotal > 0 && (
          <div className="mb-4 flex items-center gap-2 rounded-lg border border-violet-400/30 bg-violet-500/15 px-3 py-2 text-xs text-violet-200">
            {event.handlersDone} of {event.handlersTotal} handlers acknowledged
          </div>
        )}

        <div className="mb-4 flex items-center gap-2 rounded-lg border border-sky-400/25 bg-sky-400/10 px-3 py-2 text-xs text-sky-200">
          <Inbox size={14} className="shrink-0" />
          <span>
            No UI handler is registered for <span className="font-mono">{event.type}</span> — showing the generic
            event view.
          </span>
        </div>

        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/50">Payload</div>
        <div className="mb-4 overflow-hidden rounded-lg border border-white/10 bg-white/[0.02]">
          {entries.length === 0 ? (
            <div className="p-3 text-xs text-white/35">No payload</div>
          ) : (
            entries.map(([k, v]) => (
              <div key={k} className="grid grid-cols-[160px_1fr] gap-3 border-t border-white/5 px-3 py-1.5 first:border-t-0">
                <div className="truncate font-mono text-[11px] text-white/50">{k}</div>
                <div className="break-words font-mono text-[11px] text-white/80">{formatValue(v)}</div>
              </div>
            ))
          )}
        </div>

        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/50">
          Processing history{" "}
          <span className="ml-1 font-normal normal-case text-white/35">
            {event.history.length} handler{event.history.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="overflow-hidden rounded-lg border border-white/10 bg-white/[0.02]">
          {event.history.length === 0 ? (
            <div className="p-3 text-xs text-white/35">
              No active headless handlers for this event type — processed immediately on emission.
            </div>
          ) : (
            event.history.map((h, i) => (
              <div
                key={`${h.handlerId}-${h.attempt}-${i}`}
                className="flex items-start gap-2.5 border-t border-white/5 px-3 py-2.5 first:border-t-0"
              >
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
                    h.status === "acked"
                      ? "bg-emerald-500/15 text-emerald-300"
                      : h.status === "failed"
                        ? "bg-amber-400/15 text-amber-200"
                        : "bg-red-500/15 text-red-300"
                  }`}
                >
                  {h.status === "acked" ? <Check size={12} /> : h.status === "failed" ? <RotateCw size={12} /> : <AlertTriangle size={12} />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-semibold text-white/90">{h.handlerId}</span>
                    <span className="rounded bg-sky-400/20 px-1.5 py-0.5 text-[10px] text-sky-200">headless</span>
                    <span className="ml-auto shrink-0 text-[11px] text-white/40">{relTime(h.ts)}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-white/50">
                    {h.status === "acked" && `Acknowledged · attempt ${h.attempt}`}
                    {h.status === "failed" && `Failed attempt ${h.attempt} of 3 · retrying with backoff`}
                    {h.status === "permanently_failed" && "Permanently failed after 3 attempts · does not block completion"}
                  </div>
                  {h.result !== undefined && (
                    <div className="mt-0.5 truncate font-mono text-[11px] text-white/45">→ {formatValue(h.result)}</div>
                  )}
                  {h.error && (
                    <div className="mt-0.5 flex items-center gap-1 text-[11px] text-red-300">
                      <AlertTriangle size={11} /> {h.error}
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
