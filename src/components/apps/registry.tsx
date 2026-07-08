"use client";

import type { AppComponent } from "./types";
import { BUILTIN_COMPONENTS } from "@/apps/_components.generated";

// Maps an app id to the React component rendered inside its window. Built-in
// apps are discovered from src/apps/<id>/index.tsx at build time (see
// tools/gen-apps.mjs); only first-class React apps render through here, while
// runtime-installed apps load as iframes. registerAppComponent lets a future
// runtime loader add more.
const REGISTRY = new Map<string, AppComponent>(Object.entries(BUILTIN_COMPONENTS));

export function getAppComponent(appId: string): AppComponent | undefined {
  return REGISTRY.get(appId);
}

export function registerAppComponent(appId: string, component: AppComponent): void {
  REGISTRY.set(appId, component);
}
