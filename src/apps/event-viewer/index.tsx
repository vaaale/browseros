"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bell as BellIcon, Check, Inbox, SlidersHorizontal } from "lucide-react";
import type { AppProps } from "@/components/apps/types";
import { useOSStore } from "@/store/os-provider";
import { subscribeEventStream } from "@/components/desktop/subscribeEventStream";
import type { EventSummaryView } from "@/lib/events/types";
import { EventsList } from "./EventsList";
import { EventDetail } from "./EventDetail";
import { HandlerDialog, type UiHandlerOption } from "./HandlerDialog";
import { ConfigPanel } from "./ConfigPanel";
import type { HandlerGroup } from "./types";

type Tab = "events" | "config";

interface QueryResponse {
  events: EventSummaryView[];
  nextCursor: string | null;
  unreadTotal: number;
}
interface CountResponse {
  unreadTotal: number;
  pendingTotal: number;
  grandTotal: number;
}

/** A minimal, self-contained reference to the event a launch targets — NOT a
 *  live lookup into the `events` list, which may have already moved on
 *  (marking read triggers a background refetch that drops the event from
 *  the unread page) by the time the user confirms a dialog. */
interface EventRef {
  id: string;
  type: string;
  sequence: number;
}

interface PendingDialog {
  event: EventRef;
  options: UiHandlerOption[];
}

// The built-in Event Viewer app (034-event-notification-system) — Events tab
// (unread-by-default list, generic detail, "Open with…" dialog) and
// Configuration tab. Matches mockup.html (the binding UI contract).
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- required by AppComponent's signature
export default function EventViewer(_props: AppProps) {
  const launch = useOSStore((s) => s.launch);

  const [tab, setTab] = useState<Tab>("events");
  const [showHistorical, setShowHistorical] = useState(false);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<PendingDialog | null>(null);

  const [events, setEvents] = useState<EventSummaryView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  const [counts, setCounts] = useState<CountResponse>({ unreadTotal: 0, pendingTotal: 0, grandTotal: 0 });
  const [configRefreshKey, setConfigRefreshKey] = useState(0);

  const showHistoricalRef = useRef(showHistorical);
  useEffect(() => {
    showHistoricalRef.current = showHistorical;
  });
  const loadingMoreRef = useRef(false);

  const readFilter = showHistorical ? "read" : "unread";

  const loadFirstPage = useCallback(async (read: "unread" | "read") => {
    const res = (await fetch(`/api/events?read=${read}&limit=50`).then((r) => r.json())) as QueryResponse;
    setEvents(res.events ?? []);
    setCursor(res.nextCursor ?? null);
    setHasMore(!!res.nextCursor);
  }, []);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    try {
      const res = (await fetch(`/api/events?read=${readFilter}&limit=50&cursor=${cursor}`).then((r) => r.json())) as QueryResponse;
      setEvents((prev) => [...prev, ...(res.events ?? [])]);
      setCursor(res.nextCursor ?? null);
      setHasMore(!!res.nextCursor);
    } finally {
      loadingMoreRef.current = false;
    }
  }, [cursor, readFilter]);

  const refreshCounts = useCallback(async () => {
    try {
      const res = (await fetch("/api/events/count").then((r) => r.json())) as CountResponse;
      setCounts(res);
    } catch {
      // Non-fatal — footer counts just stay stale until the next tick.
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadFirstPage(readFilter);
  }, [readFilter, loadFirstPage]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshCounts();
  }, [refreshCounts]);

  // Real-time updates (FR-028/NFR-009): reload the current page + counts on
  // any state-change notification. A short debounce coalesces bursts.
  useEffect(() => {
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeEventStream((msg) => {
      if (msg.kind === "new" && msg.eventId && !showHistoricalRef.current) {
        const id = msg.eventId;
        setFlashIds((prev) => new Set(prev).add(id));
        setTimeout(() => {
          setFlashIds((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        }, 2200);
      }
      if (msg.kind === "handlers") setConfigRefreshKey((k) => k + 1);
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        void loadFirstPage(showHistoricalRef.current ? "read" : "unread");
        void refreshCounts();
      }, 150);
    });
    return () => {
      unsubscribe();
      if (debounce) clearTimeout(debounce);
    };
  }, [loadFirstPage, refreshCounts]);

  const markRead = useCallback(async (id: string) => {
    await fetch(`/api/events/${encodeURIComponent(id)}/read`, { method: "POST" });
  }, []);

  const resolveAndLaunch = useCallback(
    (option: UiHandlerOption & { launch?: { appId: string; componentHint?: string } }, event: EventRef) => {
      const appId = option.launch?.appId;
      if (!appId) return;
      launch(appId, { event: { id: event.id, type: event.type, seq: event.sequence }, handler: option.handlerId });
    },
    [launch],
  );

  const onRowClick = useCallback(
    async (id: string) => {
      const event = events.find((e) => e.id === id);
      await markRead(id);
      // Optimistic local update so the row doesn't wait for the stream round-trip.
      setEvents((prev) => prev.map((e) => (e.id === id ? { ...e, read: "read" } : e)));
      void refreshCounts();

      if (!event) {
        setSelectedEventId(id);
        return;
      }
      // Captured now — never re-looked-up from `events` later, which may
      // have already dropped this (now-read) event via a background refetch.
      const eventRef: EventRef = { id: event.id, type: event.type, sequence: event.sequence };

      try {
        const groups = (await fetch("/api/events/handlers").then((r) => r.json())) as Record<string, HandlerGroup>;
        const group = groups[event.type];
        const uiHandlers = group?.ui ?? [];

        if (uiHandlers.length === 0) {
          setSelectedEventId(id);
          return;
        }

        const defaultHandler = uiHandlers.find((h) => h.isDefault);
        if (defaultHandler) {
          resolveAndLaunch(defaultHandler, eventRef);
          return;
        }
        if (uiHandlers.length === 1) {
          resolveAndLaunch(uiHandlers[0], eventRef);
          return;
        }
        setDialog({ event: eventRef, options: uiHandlers });
      } catch {
        // Handler lookup failed — fall back to the generic view rather than
        // silently doing nothing on click.
        setSelectedEventId(id);
      }
    },
    [events, markRead, refreshCounts, resolveAndLaunch],
  );

  const confirmDialog = useCallback(
    async (handlerId: string, alwaysUse: boolean) => {
      if (!dialog) return;
      const option = dialog.options.find((o) => o.handlerId === handlerId);
      if (alwaysUse) {
        await fetch("/api/events/preference", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ eventType: dialog.event.type, preferredHandlerId: handlerId }),
        });
      }
      setDialog(null);
      if (option) resolveAndLaunch(option, dialog.event);
    },
    [dialog, resolveAndLaunch],
  );

  const markAllRead = useCallback(async () => {
    await fetch("/api/events/read?all=1", { method: "POST" });
    void loadFirstPage(readFilter);
    void refreshCounts();
  }, [loadFirstPage, readFilter, refreshCounts]);

  const toggleHistorical = () => {
    setShowHistorical((v) => !v);
    setSelectedEventId(null);
  };

  const body = useMemo(() => {
    if (tab === "config") return <ConfigPanel refreshKey={configRefreshKey} />;
    if (selectedEventId) return <EventDetail eventId={selectedEventId} onBack={() => setSelectedEventId(null)} />;
    return (
      <EventsList
        events={events}
        flashIds={flashIds}
        onSelect={(id) => void onRowClick(id)}
        hasMore={hasMore}
        onLoadMore={() => void loadMore()}
        showHistorical={showHistorical}
      />
    );
  }, [tab, configRefreshKey, selectedEventId, events, flashIds, hasMore, loadMore, onRowClick, showHistorical]);

  return (
    <div className="flex h-full flex-col" data-testid="event-viewer">
      <div className="flex shrink-0 items-center gap-1 border-b border-white/10 bg-white/5 px-2 py-1.5">
        <button
          type="button"
          onClick={() => {
            setTab("events");
            setSelectedEventId(null);
          }}
          className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs transition-colors ${
            tab === "events" ? "bg-white/15 text-white" : "text-white/70 hover:bg-white/10"
          }`}
        >
          <Inbox size={14} /> Events
        </button>
        <button
          type="button"
          onClick={() => setTab("config")}
          className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs transition-colors ${
            tab === "config" ? "bg-white/15 text-white" : "text-white/70 hover:bg-white/10"
          }`}
        >
          <SlidersHorizontal size={14} /> Configuration
        </button>
        <div className="ml-auto flex items-center gap-3">
          {tab === "events" && !selectedEventId ? (
            <>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-white/60 hover:text-white/80">
                <span
                  onClick={toggleHistorical}
                  className={`relative inline-flex h-[17px] w-[30px] items-center rounded-full transition-colors ${
                    showHistorical ? "bg-white/40" : "bg-white/15"
                  }`}
                >
                  <span
                    className={`absolute h-[13px] w-[13px] rounded-full bg-white transition-transform ${
                      showHistorical ? "translate-x-[15px]" : "translate-x-[2px]"
                    }`}
                  />
                </span>
                <span onClick={toggleHistorical}>Show historical</span>
              </label>
              <button
                type="button"
                onClick={() => void markAllRead()}
                data-testid="mark-all-read"
                className="inline-flex items-center gap-1.5 rounded bg-white/10 px-2 py-1 text-[11px] hover:bg-white/20"
              >
                <Check size={13} /> Mark all as read
              </button>
            </>
          ) : (
            <span className="text-[11px] text-white/35">{tab === "config" ? "Manage event handlers" : ""}</span>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1">{body}</div>
      <div className="flex shrink-0 items-center justify-between border-t border-white/10 bg-white/[0.02] px-3 py-1.5 text-xs text-white/50">
        <span className="inline-flex items-center gap-1.5">
          <BellIcon size={11} className="text-white/30" />
          <span className="inline-flex items-center gap-1">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> Live
          </span>
        </span>
        <span>
          {counts.grandTotal} events · {counts.pendingTotal} processing
        </span>
      </div>
      {dialog && (
        <HandlerDialog
          eventType={dialog.event.type}
          options={dialog.options}
          onCancel={() => setDialog(null)}
          onConfirm={(handlerId, alwaysUse) => void confirmDialog(handlerId, alwaysUse)}
        />
      )}
    </div>
  );
}
