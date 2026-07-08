"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell } from "lucide-react";

// Topbar badge that shows the count of unread integration notifications.
// Clicking it marks everything as read and clears the badge. Polls the
// unread-count endpoint every 15s; that endpoint reads only the JSON header
// so it's cheap to hit.
export function IntegrationsBadge() {
  const [count, setCount] = useState<number>(0);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/integrations/notifications?count=1").then((r) => r.json());
      setCount(typeof res.unread === "number" ? res.unread : 0);
    } catch {
      // Non-fatal — the badge just stays where it was.
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const id = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(id);
  }, [refresh]);

  const onClick = async () => {
    if (count === 0) return;
    try {
      await fetch("/api/integrations/notifications", { method: "POST" });
    } finally {
      await refresh();
    }
  };

  // Zero state stays visible (as a subtle icon) so the user can still see the
  // affordance exists even when nothing is pending. The badge counter only
  // renders when > 0.
  return (
    <button
      type="button"
      onClick={onClick}
      title={count === 0 ? "No new notifications" : `${count} unread notification${count === 1 ? "" : "s"}. Click to mark all read.`}
      className="relative inline-flex h-6 w-6 items-center justify-center rounded text-white/70 transition-colors hover:bg-white/10 hover:text-white"
    >
      <Bell size={14} strokeWidth={1.75} />
      {count > 0 && (
        <span
          data-testid="integrations-badge"
          className="pointer-events-none absolute -right-1 -top-1 min-w-[16px] rounded-full bg-red-500 px-1 text-center text-[10px] font-semibold leading-4 text-white shadow"
        >
          {count > 99 ? "99+" : count}
        </span>
      )}
    </button>
  );
}
