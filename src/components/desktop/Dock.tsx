"use client";

import { useOSStore } from "@/store/os-provider";
import { AppIcon } from "./icons";

export function Dock() {
  const apps = useOSStore((s) => s.apps);
  const windows = useOSStore((s) => s.windows);
  const launch = useOSStore((s) => s.launch);
  const focus = useOSStore((s) => s.focus);

  const runningAppIds = new Set(windows.map((w) => w.appId));

  const onClick = (appId: string) => {
    const existing = windows.find((w) => w.appId === appId);
    if (existing) {
      focus(existing.id);
    } else {
      launch(appId);
    }
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[100000] flex justify-center pb-3">
      <div data-testid="dock" className="pointer-events-auto flex select-none items-end gap-2 rounded-2xl border border-white/10 bg-black/30 px-3 py-2 shadow-2xl backdrop-blur-xl">
        {apps.filter((app) => !app.hidden).map((app) => (
          <button
            key={app.id}
            data-testid={`dock-${app.id}`}
            onClick={() => onClick(app.id)}
            title={app.name}
            className="group relative flex h-12 w-12 items-center justify-center rounded-xl bg-white/5 text-white/80 transition-all hover:-translate-y-1 hover:bg-white/15 hover:text-white"
          >
            <AppIcon name={app.icon} size={24} strokeWidth={1.75} />
            {runningAppIds.has(app.id) && (
              <span className="absolute -bottom-1 h-1 w-1 rounded-full bg-white/80" />
            )}
            <span className="pointer-events-none absolute -top-9 whitespace-nowrap rounded-md bg-black/80 px-2 py-1 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100">
              {app.name}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
