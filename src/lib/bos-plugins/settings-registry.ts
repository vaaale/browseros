import type { SettingsPanelRegistration } from "./types";

const KEY = "__bos_plugin_settings__" as const;

function getRegistry(): Map<string, SettingsPanelRegistration> {
  const g = globalThis as Record<string, unknown>;
  if (!g[KEY]) g[KEY] = new Map<string, SettingsPanelRegistration>();
  return g[KEY] as Map<string, SettingsPanelRegistration>;
}

export function registerSettingsPanel(entry: SettingsPanelRegistration): void {
  getRegistry().set(entry.pluginId, entry);
}

export function unregisterSettingsPanel(pluginId: string): void {
  getRegistry().delete(pluginId);
}

export function listSettingsPanels(): SettingsPanelRegistration[] {
  return [...getRegistry().values()];
}
