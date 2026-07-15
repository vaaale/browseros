import { createStore } from "zustand/vanilla";
import type {
  AppManifest,
  FeatureContext,
  OSSettings,
  WindowBounds,
  WindowInstance,
} from "@/os/types";

export interface OSState {
  windows: WindowInstance[];
  focusedId: string | null;
  zCounter: number;
  settings: OSSettings;
  apps: AppManifest[];
  /** Read-only mirror of the server-authoritative active Feature Context. */
  activeFeature: FeatureContext | null;

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

  // Feature Context intents — the server module is the single writer; these
  // await the API and refresh the mirror, then broadcast to other tabs.
  setActiveFeature: (id: string, description?: string) => Promise<void>;
  clearActiveFeature: () => Promise<void>;
  refreshActiveFeature: () => Promise<void>;
}

export interface OSInit {
  settings: OSSettings;
  apps: AppManifest[];
  /** SSR-seeded active Feature Context (optional). */
  activeFeature?: FeatureContext | null;
}

const FEATURE_CHANNEL = "bos-feature-context";

const TOPBAR_H = 32;
const MARGIN = 24;

/** Returns the width/height a new window should open at.
 *  Uses 80% of the viewport, but never smaller than the manifest's default. */
function launchSize(defaultWidth: number, defaultHeight: number): { width: number; height: number } {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  return {
    width:  Math.max(defaultWidth,  Math.round(vw * 0.80)),
    height: Math.max(defaultHeight, Math.round((vh - TOPBAR_H) * 0.80)),
  };
}

function nextLaunchOrigin(count: number, width: number, height: number): { x: number; y: number } {
  const step = 28;
  const cascade = (count % 6) * step;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  return {
    x: Math.max(0, Math.round((vw - width) / 2) + cascade),
    y: Math.max(TOPBAR_H, Math.round((vh - height) / 2) + cascade),
  };
}

export function createOSStore(init: OSInit) {
  // Cross-tab sync: when one tab changes the active feature, others refresh
  // their read-only mirror so a stale tab never believes the wrong feature is
  // active. Guarded for SSR / environments without BroadcastChannel.
  const channel =
    typeof window !== "undefined" && typeof BroadcastChannel !== "undefined"
      ? new BroadcastChannel(FEATURE_CHANNEL)
      : null;

  return createStore<OSState>()((set, get) => {
    if (channel) channel.onmessage = () => void get().refreshActiveFeature();
    return {
    windows: [],
    focusedId: null,
    zCounter: 1,
    settings: init.settings,
    apps: init.apps,
    activeFeature: init.activeFeature ?? null,

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
      const { width, height } = launchSize(app.defaultWidth, app.defaultHeight);
      const origin = nextLaunchOrigin(get().windows.length, width, height);
      const z = get().zCounter + 1;
      const win: WindowInstance = {
        id,
        appId,
        title: app.name,
        x: origin.x,
        y: origin.y,
        width,
        height,
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

    setActiveFeature: async (id, description) => {
      const res = await fetch("/api/feature-context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, description }),
      });
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(error || `Failed to set feature (${res.status})`);
      }
      const { active } = (await res.json()) as { active: FeatureContext | null };
      set({ activeFeature: active });
      channel?.postMessage({ t: "changed" });
    },

    clearActiveFeature: async () => {
      const res = await fetch("/api/feature-context", { method: "DELETE" });
      if (!res.ok) throw new Error(`Failed to clear feature (${res.status})`);
      set({ activeFeature: null });
      channel?.postMessage({ t: "changed" });
    },

    refreshActiveFeature: async () => {
      const res = await fetch("/api/feature-context");
      if (!res.ok) return;
      const { active } = (await res.json()) as { active: FeatureContext | null };
      set({ activeFeature: active });
    },
    };
  });
}

export type OSStoreApi = ReturnType<typeof createOSStore>;
