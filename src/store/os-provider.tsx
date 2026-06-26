"use client";

import { createContext, useContext, useRef, type ReactNode } from "react";
import { useStore } from "zustand";
import type { AppManifest, OSSettings } from "@/os/types";
import { createOSStore, type OSState, type OSStoreApi } from "./os-store";

const OSStoreContext = createContext<OSStoreApi | null>(null);

export function OSProvider({
  settings,
  apps,
  children,
}: {
  settings: OSSettings;
  apps: AppManifest[];
  children: ReactNode;
}) {
  // Create the store exactly once per client/render tree. Seeding from server
  // props keeps SSR markup and the first client render in sync.
  const ref = useRef<OSStoreApi | null>(null);
  if (ref.current === null) {
    ref.current = createOSStore({ settings, apps });
  }
  return <OSStoreContext.Provider value={ref.current}>{children}</OSStoreContext.Provider>;
}

export function useOSStore<T>(selector: (state: OSState) => T): T {
  const store = useContext(OSStoreContext);
  if (!store) throw new Error("useOSStore must be used within an <OSProvider>");
  return useStore(store, selector);
}

/** Access the raw store API for fresh getState()/setState() reads in callbacks. */
export function useOSStoreApi(): OSStoreApi {
  const store = useContext(OSStoreContext);
  if (!store) throw new Error("useOSStoreApi must be used within an <OSProvider>");
  return store;
}
