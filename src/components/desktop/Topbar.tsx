"use client";

import { useEffect, useState } from "react";
import { useOSStore } from "@/store/os-provider";
import { VersionControls } from "./VersionControls";

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
      <div className="justify-self-end">
        <Clock />
      </div>
    </div>
  );
}
