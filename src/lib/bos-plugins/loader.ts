import "server-only";
import { promises as fs } from "fs";
import path from "path";
import type { BosPluginManifest, BosPluginModule, BosPluginContext } from "./types";
import { registerRoute, unregisterRoutes } from "./route-registry";
import { registerSettingsPanel, unregisterSettingsPanel } from "./settings-registry";
import { registerVoiceEngine, unregisterVoiceEngine } from "@/lib/voice/engine-registry";
import { registerIntegration, unregisterIntegration } from "@/lib/integrations/registry";
import { registerAdapter, unregisterAdapter } from "@/lib/integrations/actions/adapter-registry";
import { registerWebhookHandler, unregisterWebhookHandler } from "@/lib/integrations/webhooks/registry";
import { registerAdditionalCapabilities, unregisterCapabilities } from "@/lib/agent/capabilities-registry";
import { readNamespace, patchNamespace } from "@/lib/config/store";

const LOADED_KEY = "__bos_loaded_plugins__" as const;

interface LoadedEntry {
  manifest: BosPluginManifest;
  module: BosPluginModule;
}

function getLoaded(): Map<string, LoadedEntry> {
  const g = globalThis as Record<string, unknown>;
  if (!g[LOADED_KEY]) g[LOADED_KEY] = new Map<string, LoadedEntry>();
  return g[LOADED_KEY] as Map<string, LoadedEntry>;
}

function makeContext(pluginId: string): BosPluginContext {
  return {
    pluginId,
    log: {
      info: (msg) => console.log(`[bos-plugin:${pluginId}] ${msg}`),
      warn: (msg) => console.warn(`[bos-plugin:${pluginId}] ${msg}`),
      error: (msg) => console.error(`[bos-plugin:${pluginId}] ${msg}`),
    },
  };
}

/** The SDK object injected into plugins that use the factory-function export pattern. */
function makeSdk() {
  return {
    registerRoute,
    unregisterRoutes,
    registerSettingsPanel,
    unregisterSettingsPanel,
    registerVoiceEngine,
    unregisterVoiceEngine,
    registerIntegration,
    unregisterIntegration,
    registerAdapter,
    unregisterAdapter,
    registerWebhookHandler,
    unregisterWebhookHandler,
    registerAdditionalCapabilities,
    unregisterCapabilities,
    /** Read this plugin's own config (stored under namespace plugin:<id>). */
    readConfig: async (pluginId: string) => readNamespace(`plugin:${pluginId}`),
    /** Patch this plugin's own config. */
    patchConfig: async (pluginId: string, patch: Record<string, unknown>) =>
      patchNamespace(`plugin:${pluginId}`, patch),
  };
}

export async function loadPlugin(pluginDir: string): Promise<void> {
  const manifestPath = path.join(pluginDir, "bos-plugin.json");
  let manifest: BosPluginManifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as BosPluginManifest;
  } catch {
    console.warn(`[bos-plugins] Skipping ${pluginDir}: missing or invalid bos-plugin.json`);
    return;
  }
  if (!manifest.id) {
    console.warn(`[bos-plugins] Skipping ${pluginDir}: manifest missing id`);
    return;
  }
  if (getLoaded().has(manifest.id)) return;

  const entryFile = path.join(pluginDir, manifest.entry ?? "index.js");
  let mod: BosPluginModule;
  try {
    const raw = await import(/* webpackIgnore: true */ entryFile) as unknown;
    // Support two export patterns:
    //   1. Factory function: module.exports = (sdk) => { ... return { activate, deactivate } }
    //   2. Object: module.exports = { activate, deactivate }
    const exported = (raw as { default?: unknown }).default ?? raw;
    if (typeof exported === "function") {
      mod = (exported as (sdk: ReturnType<typeof makeSdk>) => BosPluginModule)(makeSdk());
    } else {
      mod = exported as BosPluginModule;
    }
  } catch (err) {
    console.error(`[bos-plugins] Failed to load plugin ${manifest.id}:`, err);
    return;
  }

  const ctx = makeContext(manifest.id);
  try {
    await mod.activate?.(ctx);
  } catch (err) {
    console.error(`[bos-plugins] activate() failed for ${manifest.id}:`, err);
    return;
  }

  getLoaded().set(manifest.id, { manifest, module: mod });
  ctx.log.info(`loaded v${manifest.version}`);
}

/**
 * Load every installed item's plugin facet. A plugin is an ordinary item (035
 * FR-008) — discovered by the ONE shared installed-item scan, not by listing a
 * private plugin directory. `dataDir()/bos-plugins/` is gone.
 */
export async function loadAllPlugins(): Promise<void> {
  const { listInstalledItems, itemLinkPath } = await import("@/system/items/installed");
  const items = (await listInstalledItems()).filter((i) => i.facets.plugin && !i.broken);
  await Promise.all(items.map((i) => loadPlugin(path.join(itemLinkPath(i.id), "plugin"))));
}

export function listLoadedPlugins(): BosPluginManifest[] {
  return [...getLoaded().values()].map((e) => e.manifest);
}

export function getLoadedPluginModule(id: string): BosPluginModule | undefined {
  return getLoaded().get(id)?.module;
}

export function unloadPlugin(id: string): void {
  getLoaded().delete(id);
}
