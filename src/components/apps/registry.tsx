"use client";

import type { AppComponent } from "./types";
import { FileBrowser } from "./FileBrowser";
import { WebBrowser } from "./WebBrowser";
import { SettingsApp } from "./SettingsApp";
import { ChatApp } from "./ChatApp";
import { MemoryApp } from "./MemoryApp";
import { DocsApp } from "./DocsApp";

// Maps an app id to the client component that renders inside its window.
// Runtime-installed apps register here via registerAppComponent().
const REGISTRY = new Map<string, AppComponent>([
  ["files", FileBrowser],
  ["browser", WebBrowser],
  ["settings", SettingsApp],
  ["chat", ChatApp],
  ["memory", MemoryApp],
  ["docs", DocsApp],
]);

export function getAppComponent(appId: string): AppComponent | undefined {
  return REGISTRY.get(appId);
}

export function registerAppComponent(appId: string, component: AppComponent): void {
  REGISTRY.set(appId, component);
}
