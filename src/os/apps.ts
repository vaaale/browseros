import type { AppManifest } from "./types";

// Built-in applications that ship with BrowserOS. The registry is the
// extensibility seam: runtime-installed apps are appended to this set
// (see the dev harness / app SDK in later phases).
export const BUILTIN_APPS: AppManifest[] = [
  { id: "files", name: "Files", icon: "Folder", defaultWidth: 760, defaultHeight: 500, builtin: true },
  { id: "browser", name: "Browser", icon: "Globe", defaultWidth: 940, defaultHeight: 620, builtin: true },
  { id: "chat", name: "Assistant", icon: "Bot", defaultWidth: 440, defaultHeight: 640, singleton: true, builtin: true },
  { id: "memory", name: "Memory", icon: "Brain", defaultWidth: 640, defaultHeight: 520, singleton: true, builtin: true },
  { id: "docs", name: "Docs", icon: "BookOpen", defaultWidth: 760, defaultHeight: 560, singleton: true, builtin: true },
  { id: "devstudio", name: "Dev Studio", icon: "Wrench", defaultWidth: 560, defaultHeight: 560, singleton: true, builtin: true },
  { id: "settings", name: "Settings", icon: "Settings", defaultWidth: 680, defaultHeight: 500, singleton: true, builtin: true },
];

export function getApp(id: string, apps: AppManifest[] = BUILTIN_APPS): AppManifest | undefined {
  return apps.find((a) => a.id === id);
}
