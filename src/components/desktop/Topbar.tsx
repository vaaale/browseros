"use client";

import { useEffect, useState } from "react";
import { LogOut } from "lucide-react";
import { useOSStore } from "@/store/os-provider";
import { VersionControls } from "./VersionControls";
import { IntegrationsBadge } from "./IntegrationsBadge";

function LogoutButton() {
  const [multiUser, setMultiUser] = useState(false);

  useEffect(() => {
    fetch("/api/system/session")
      .then((r) => r.json())
      .then((d) => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setMultiUser(!!d.multiUser);
      })
      .catch(() => {});
  }, []);

  if (!multiUser) return null;

  const logout = async () => {
    await fetch("/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/app/login";
  };

  return (
    <button
      type="button"
      onClick={logout}
      title="Log out"
      className="inline-flex h-6 w-6 items-center justify-center rounded text-white/70 transition-colors hover:bg-white/10 hover:text-white"
    >
      <LogOut size={14} strokeWidth={1.75} />
    </button>
  );
}

function Clock() {
  const [now, setNow] = useState<string>("");
  useEffect(() => {
    const tick = () =>
      setNow(
        new Date().toLocaleString(undefined, {
          weekday: "short",
          hour: "2-digit",
          minute: "2-digit",
        }),
      );
    tick();
    const id = setInterval(tick, 15_000);
    return () => clearInterval(id);
  }, []);
  // Empty on first paint avoids a server/client hydration mismatch.
  return <span suppressHydrationWarning>{now}</span>;
}

export function Topbar() {
  const windows = useOSStore((s) => s.windows);
  const focusedId = useOSStore((s) => s.focusedId);
  const focused = windows.find((w) => w.id === focusedId);

  return (
    <div className="absolute inset-x-0 top-0 z-[100000] grid h-8 grid-cols-[1fr_auto_1fr] items-center border-b border-white/10 bg-black/30 px-4 text-xs text-white/80 backdrop-blur-xl select-none">
      <div className="flex min-w-0 items-center gap-3">
        <span className="font-semibold tracking-tight text-white">BrowserOS</span>
        <span className="truncate text-white/60">{focused?.title ?? "Desktop"}</span>
      </div>
      <div className="justify-self-center">
        <VersionControls />
      </div>
      <div className="flex items-center gap-2 justify-self-end">
        <IntegrationsBadge />
        <Clock />
        <LogoutButton />
      </div>
    </div>
  );
}
