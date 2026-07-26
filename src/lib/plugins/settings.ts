import "server-only";
import type { PluginStatus } from "./types";
import {
  listPlugins,
  getPlugin,
  readPluginsConfig,
  writePluginsConfig,
  ensurePluginInitialized,
  disposePluginIfInitialized,
} from "./registry";
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

/**
 * Save plugin config and optionally toggle active state. Beyond persisting
 * plugins.json, this also runs the plugin's own lifecycle hooks so a Settings
 * change actually takes effect live (no server restart required):
 *   - newly active  → initialize() (e.g. the memory plugin seeds/resumes its
 *     scheduler jobs)
 *   - newly inactive → dispose() (e.g. pauses those jobs)
 *   - config changed on an already-active plugin → setConfig(), if the plugin
 *     defines one (the memory plugin re-seeds jobs with the new intervals)
 * Previously this function only wrote JSON — the toggle and per-field Save
 * buttons in Settings → Plugins had no live effect at all until next boot.
 */
export async function savePluginSettings(
  pluginId: string,
  patch: { active?: boolean; config?: Record<string, unknown>; order?: number },
): Promise<void> {
  const config = await readPluginsConfig();
  const wasActive = config.active.includes(pluginId);

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

  const nowActive = config.active.includes(pluginId);
  const plugin = getPlugin(pluginId);
  if (!plugin) return; // not loaded into this process yet — nothing live to run

  try {
    if (nowActive && !wasActive) {
      await ensurePluginInitialized(pluginId);
    } else if (!nowActive && wasActive) {
      await disposePluginIfInitialized(pluginId);
    } else if (nowActive && patch.config && plugin.setConfig) {
      await plugin.setConfig(patch.config);
    }
  } catch (err) {
    logger().error(COMPONENT, `plugin lifecycle hook failed for ${pluginId}`, undefined, {
      error: (err as Error).message,
    });
  }
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
