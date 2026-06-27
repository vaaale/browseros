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
    <div className="absolute inset-x-0 top-0 z-[100000] flex h-8 items-center justify-between border-b border-white/10 bg-black/30 px-4 text-xs text-white/80 backdrop-blur-xl select-none">
      <div className="flex items-center gap-3">
        <span className="font-semibold tracking-tight text-white">BrowserOS</span>
        <span className="text-white/60">{focused?.title ?? "Desktop"}</span>
      </div>
      <div className="flex items-center gap-3">
        <VersionControls />
        <Clock />
      </div>
    </div>
  );
}
