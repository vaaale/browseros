"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { useOSStore } from "@/store/os-provider";
import { subscribeEventStream } from "./subscribeEventStream";

// Topbar bell (034-event-notification-system, ADR-6): shows the UNREAD event
// count (not pending) and opens the Event Viewer. Replaces IntegrationsBadge —
// the legacy GSuite/Telegram notification inbox is migrated onto this system.
export function EventBell() {
  const [count, setCount] = useState(0);
  const launch = useOSStore((s) => s.launch);

  const refresh = useCallback(async () => {
    try {
      const res = (await fetch("/api/events/count").then((r) => r.json())) as { unreadTotal?: number };
      setCount(typeof res.unreadTotal === "number" ? res.unreadTotal : 0);
    } catch {
      // Non-fatal — the badge just stays where it was.
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const unsubscribe = subscribeEventStream((msg) => {
      if (msg.kind === "new" || msg.kind === "read") void refresh();
    });
    // Fallback poll in case the stream connection drops (NFR-008: ≤1s from a
    // state change under normal operation; this is belt-and-braces).
    const poll = setInterval(() => void refresh(), 15_000);
    return () => {
      unsubscribe();
      clearInterval(poll);
    };
  }, [refresh]);

  const onClick = () => {
    launch("event-viewer");
  };

  return (
    <button
      type="button"
      onClick={onClick}
      title={count === 0 ? "No new events" : `${count} unread event${count === 1 ? "" : "s"}`}
      className="relative inline-flex h-6 w-6 items-center justify-center rounded text-white/70 transition-colors hover:bg-white/10 hover:text-white"
    >
      <Bell size={14} strokeWidth={1.75} />
      {count > 0 && (
        <span
          data-testid="event-bell-badge"
          className="pointer-events-none absolute -right-1 -top-1 min-w-[16px] rounded-full bg-red-500 px-1 text-center text-[10px] font-semibold leading-4 text-white shadow"
        >
          {count > 99 ? "99+" : count}
        </span>
      )}
    </button>
  );
}
