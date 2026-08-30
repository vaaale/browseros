"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Inbox, History as HistoryIcon } from "lucide-react";
import { AppIcon } from "@/components/desktop/icons";
import type { EventSummaryView } from "@/lib/events/types";
import { relTime } from "./format";

// Hand-rolled fixed-row-height windowing (ADR-5): renders only the rows in
// the visible range (± overscan), backed by a cursor-paginated `events` array
// that grows via onLoadMore as the user scrolls near the bottom. Keeps the
// list responsive at the 100k-event floor (FR-025, SC-002) without a
// dependency (Constitution VII).
const ROW_HEIGHT = 56;
const OVERSCAN = 6;

export function EventsList({
  events,
  flashIds,
  onSelect,
  hasMore,
  onLoadMore,
  showHistorical,
}: {
  events: EventSummaryView[];
  flashIds: Set<string>;
  onSelect: (id: string) => void;
  hasMore: boolean;
  onLoadMore: () => void;
  showHistorical: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      setScrollTop(el.scrollTop);
      if (hasMore && el.scrollHeight - el.scrollTop - el.clientHeight < el.clientHeight * 2) {
        onLoadMore();
      }
    };
    setViewport(el.clientHeight);
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [hasMore, onLoadMore]);

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil((viewport || 400) / ROW_HEIGHT) + OVERSCAN * 2;
  const end = Math.min(events.length, start + visibleCount);
  const visible = useMemo(() => events.slice(start, end), [events, start, end]);

  if (events.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center" data-testid="events-empty">
        {showHistorical ? <HistoryIcon size={40} className="text-white/15" /> : <Inbox size={40} className="text-white/15" />}
        <h3 className="text-xs font-medium text-white/60">
          {showHistorical ? "No historical events yet" : "You're all caught up"}
        </h3>
        <p className="max-w-[260px] text-xs text-white/40">
          {showHistorical ? "Events you've read will appear here." : "New events from your apps and services land here."}
        </p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="h-full min-h-0 overflow-auto" data-testid="events-list">
      <div className="relative" style={{ height: events.length * ROW_HEIGHT }}>
        {visible.map((e, i) => {
          const idx = start + i;
          const flashing = flashIds.has(e.id);
          return (
            <button
              key={e.id}
              type="button"
              onClick={() => onSelect(e.id)}
              data-testid={`event-row-${e.id}`}
              style={{ position: "absolute", top: idx * ROW_HEIGHT, left: 0, right: 0, height: ROW_HEIGHT }}
              className={`flex items-center gap-3 border-t border-white/5 px-3.5 text-left transition-colors hover:bg-white/5 ${
                e.read === "read" ? "opacity-55" : ""
              } ${flashing ? "bg-violet-500/20" : ""}`}
            >
              <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/5 text-white/70">
                <AppIcon name={e.source.icon || "Bell"} size={16} />
                {e.read === "unread" && (
                  <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-violet-300 ring-2 ring-[#0f1117]" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 text-xs">
                  <span className="shrink-0 font-semibold text-white/90">{e.source.name}</span>
                  <span className="truncate font-medium text-white/70">{e.summary}</span>
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[11px] text-white/35">
                  <span className="truncate font-mono">{e.type}</span>
                  <span>seq {e.sequence}</span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {e.processing === "pending" ? (
                  <span className="inline-flex items-center gap-1.5 text-[11px] text-white/50">
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/20 border-t-white/70" />
                    processing…
                    {e.handlersTotal > 0 && (
                      <span className="text-white/30">
                        {e.handlersDone}/{e.handlersTotal}
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-[11px] text-emerald-300">
                    <Check size={12} /> processed
                  </span>
                )}
                <span className="w-14 text-right text-[11px] text-white/40 tabular-nums">{relTime(e.ts)}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
