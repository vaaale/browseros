import "server-only";
import type { PluginStatus } from "./types";
import { listPlugins, readPluginsConfig, writePluginsConfig } from "./registry";
import { logger } from "@/lib/logging";

// Settings integration — provides the data layer for the PluginsTab.

const COMPONENT = "plugins.settings";

/** Get all plugin statuses for the Settings UI. */
export async function getPluginsForSettings(): Promise<PluginStatus[]> {
  const config = await readPluginsConfig();
  const plugins = listPlugins();

  return plugins.map((p) => ({
    id: p.manifest.id,
    manifest: p.manifest,
    active: config.active.includes(p.manifest.id),
    config: config.config[p.manifest.id] ?? {},
  }));
}

/** Save plugin config and optionally toggle active state. */
export async function savePluginSettings(
  pluginId: string,
  patch: { active?: boolean; config?: Record<string, unknown>; order?: number },
): Promise<void> {
  const config = await readPluginsConfig();

  if (patch.active !== undefined) {
    const idx = config.active.indexOf(pluginId);
    if (patch.active && idx === -1) {
      config.active.push(pluginId);
    } else if (!patch.active && idx !== -1) {
      config.active.splice(idx, 1);
    }
  }

  if (patch.config) {
    config.config[pluginId] = { ...(config.config[pluginId] ?? {}), ...patch.config };
  }

  if (patch.order !== undefined) {
    // Remove and re-insert at the desired position.
    const idx = config.active.indexOf(pluginId);
    if (idx !== -1) config.active.splice(idx, 1);
    config.active.splice(Math.min(patch.order, config.active.length), 0, pluginId);
  }

  await writePluginsConfig(config);
}

/** Reorder the plugin pipeline. */
export async function setPluginOrder(orderedIds: string[]): Promise<void> {
  const config = await readPluginsConfig();
  config.active = orderedIds;
  await writePluginsConfig(config);
}

/** Initialize the default plugins (compaction + memory) if not already present. */
export async function ensureDefaultPlugins(): Promise<void> {
  const config = await readPluginsConfig();

  const defaults = [
    { id: "bos-compaction", name: "Context Compaction", initPath: "@/plugins/compaction/init" },
    { id: "bos-memory", name: "Memory System", initPath: "@/plugins/memory/init" },
  ];

  let changed = false;
  for (const d of defaults) {
    const existing = listPlugins().find((p) => p.manifest.id === d.id);
    if (!existing) {
      // Default plugins are registered by their init.ts modules which are
      // imported at startup. If they haven't been loaded yet, we skip — the
      // init module handles registration.
      continue;
    }
    if (!config.active.includes(d.id)) {
      config.active.unshift(d.id);
      changed = true;
      logger().info(COMPONENT, "default-plugin.activated", { data: { id: d.id } });
    }
  }

  if (changed) {
    await writePluginsConfig(config);
  }
}
