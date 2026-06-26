"use client";

import { useOSStore } from "@/store/os-provider";
import { wallpaperToCss } from "@/os/wallpapers";
import { Topbar } from "./Topbar";
import { Dock } from "./Dock";
import { WindowManager } from "./WindowManager";
import { FirstRunWizard } from "./FirstRunWizard";
import { AppIcon } from "./icons";

export function Desktop() {
  const settings = useOSStore((s) => s.settings);
  const apps = useOSStore((s) => s.apps);
  const launch = useOSStore((s) => s.launch);

  return (
    <div
      className="fixed inset-0 overflow-hidden"
      style={{ background: wallpaperToCss(settings.wallpaper, settings.wallpaperFit) }}
    >
      <Topbar />

      <div className="absolute left-3 top-11 flex select-none flex-col gap-3">
        {apps.map((app) => (
          <button
            key={app.id}
            onDoubleClick={() => launch(app.id)}
            className="group flex w-20 flex-col items-center gap-1 rounded-lg p-2 text-white/90 transition-colors hover:bg-white/10"
          >
            <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-black/25 shadow-lg backdrop-blur-sm">
              <AppIcon name={app.icon} size={26} strokeWidth={1.75} />
            </span>
            <span className="max-w-full truncate text-center text-[11px] drop-shadow">{app.name}</span>
          </button>
        ))}
      </div>

      <WindowManager />
      <Dock />
      <FirstRunWizard />
    </div>
  );
}
