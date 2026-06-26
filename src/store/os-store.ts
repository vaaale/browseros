import { createStore } from "zustand/vanilla";
import type { AppManifest, OSSettings, WindowBounds, WindowInstance } from "@/os/types";

export interface OSState {
  windows: WindowInstance[];
  focusedId: string | null;
  zCounter: number;
  settings: OSSettings;
  apps: AppManifest[];

  launch: (appId: string, params?: Record<string, unknown>) => string | null;
  close: (id: string) => void;
  focus: (id: string) => void;
  move: (id: string, x: number, y: number) => void;
  resize: (id: string, bounds: Partial<WindowBounds>) => void;
  toggleMaximize: (id: string) => void;
  minimize: (id: string) => void;
  setTitle: (id: string, title: string) => void;

  applySettings: (patch: Partial<OSSettings>) => void;
  registerApp: (app: AppManifest) => void;
  unregisterApp: (id: string) => void;
}

export interface OSInit {
  settings: OSSettings;
  apps: AppManifest[];
}

const TOPBAR_H = 32;
const MARGIN = 24;

function nextLaunchOrigin(count: number): { x: number; y: number } {
  const step = 28;
  return { x: 80 + (count % 6) * step, y: TOPBAR_H + 24 + (count % 6) * step };
}

export function createOSStore(init: OSInit) {
  return createStore<OSState>()((set, get) => ({
    windows: [],
    focusedId: null,
    zCounter: 1,
    settings: init.settings,
    apps: init.apps,

    launch: (appId, params) => {
      const app = get().apps.find((a) => a.id === appId);
      if (!app) return null;

      if (app.singleton) {
        const existing = get().windows.find((w) => w.appId === appId);
        if (existing) {
          get().focus(existing.id);
          if (params) {
            set((s) => ({
              windows: s.windows.map((w) =>
                w.id === existing.id ? { ...w, minimized: false, params: { ...w.params, ...params } } : w,
              ),
            }));
          }
          return existing.id;
        }
      }

      const id = `${appId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const origin = nextLaunchOrigin(get().windows.length);
      const z = get().zCounter + 1;
      const win: WindowInstance = {
        id,
        appId,
        title: app.name,
        x: origin.x,
        y: origin.y,
        width: app.defaultWidth,
        height: app.defaultHeight,
        zIndex: z,
        minimized: false,
        maximized: false,
        params,
      };
      set((s) => ({ windows: [...s.windows, win], focusedId: id, zCounter: z }));
      return id;
    },

    close: (id) =>
      set((s) => ({
        windows: s.windows.filter((w) => w.id !== id),
        focusedId: s.focusedId === id ? null : s.focusedId,
      })),

    focus: (id) =>
      set((s) => {
        const z = s.zCounter + 1;
        return {
          zCounter: z,
          focusedId: id,
          windows: s.windows.map((w) =>
            w.id === id ? { ...w, zIndex: z, minimized: false } : w,
          ),
        };
      }),

    move: (id, x, y) =>
      set((s) => ({
        windows: s.windows.map((w) =>
          w.id === id ? { ...w, x: Math.max(0, x), y: Math.max(TOPBAR_H, y) } : w,
        ),
      })),

    resize: (id, bounds) =>
      set((s) => ({
        windows: s.windows.map((w) =>
          w.id === id
            ? {
                ...w,
                ...bounds,
                width: Math.max(280, bounds.width ?? w.width),
                height: Math.max(180, bounds.height ?? w.height),
              }
            : w,
        ),
      })),

    toggleMaximize: (id) =>
      set((s) => ({
        windows: s.windows.map((w) => {
          if (w.id !== id) return w;
          if (w.maximized) {
            return { ...w, maximized: false, ...(w.prevBounds ?? {}) };
          }
          return {
            ...w,
            maximized: true,
            prevBounds: { x: w.x, y: w.y, width: w.width, height: w.height },
            x: MARGIN,
            y: TOPBAR_H + 8,
          };
        }),
      })),

    minimize: (id) =>
      set((s) => ({
        windows: s.windows.map((w) => (w.id === id ? { ...w, minimized: true } : w)),
        focusedId: s.focusedId === id ? null : s.focusedId,
      })),

    setTitle: (id, title) =>
      set((s) => ({
        windows: s.windows.map((w) => (w.id === id ? { ...w, title } : w)),
      })),

    applySettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),

    registerApp: (app) =>
      set((s) =>
        s.apps.some((a) => a.id === app.id)
          ? { apps: s.apps.map((a) => (a.id === app.id ? app : a)) }
          : { apps: [...s.apps, app] },
      ),

    unregisterApp: (id) =>
      set((s) => ({
        apps: s.apps.filter((a) => a.id !== id),
        windows: s.windows.filter((w) => w.appId !== id),
      })),
  }));
}

export type OSStoreApi = ReturnType<typeof createOSStore>;
