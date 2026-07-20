import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { logger } from "@/lib/logging";
import type { PluginManifest, PluginDefinition, PluginContext } from "./types";
import { registerPlugin, setPluginContext, readPluginsConfig, writePluginsConfig } from "./registry";
import { validateManifest } from "./validator";

const COMPONENT = "plugins";

function pluginsDir(): string {
  return path.join(dataDir(), "plugins");
}

const configDir = () => path.join(dataDir(), "config");

async function pathExists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}

/**
 * Migrate legacy config files (data/config/compaction.json and
 * data/config/memory.json) into data/config/plugins.json under the
 * appropriate plugin IDs. Runs once; legacy files are left in place
 * (non-destructive) but a .migrated marker prevents re-running.
 */
export async function migrateLegacyPluginConfigs(): Promise<void> {
  const marker = path.join(configDir(), ".plugins-migrated");
  if (await pathExists(marker)) return;

  const config = await readPluginsConfig();
  let changed = false;

  // Migrate compaction.json → bos-compaction plugin config
  try {
    const raw = await fs.readFile(path.join(configDir(), "compaction.json"), "utf8");
    const compactionCfg = JSON.parse(raw) as Record<string, unknown>;
    if (Object.keys(compactionCfg).length > 0 && !config.config["bos-compaction"]) {
      config.config["bos-compaction"] = compactionCfg;
      changed = true;
      logger().info(COMPONENT, "config.migrated", { data: { from: "compaction.json", to: "bos-compaction" } });
    }
  } catch {
    // No legacy file — skip.
  }

  // Migrate memoryLoops.json → bos-memory plugin config
  try {
    const raw = await fs.readFile(path.join(configDir(), "memoryLoops.json"), "utf8");
    const memoryCfg = JSON.parse(raw) as Record<string, unknown>;
    if (Object.keys(memoryCfg).length > 0 && !config.config["bos-memory"]) {
      config.config["bos-memory"] = memoryCfg;
      changed = true;
      logger().info(COMPONENT, "config.migrated", { data: { from: "memoryLoops.json", to: "bos-memory" } });
    }
  } catch {
    // No legacy file — skip.
  }

  if (changed) {
    await writePluginsConfig(config);
  }

  // Write marker so we don't run again.
  await fs.writeFile(marker, new Date().toISOString(), "utf8").catch(() => {});
}

/** Load a single plugin from its directory. */
export async function loadPluginFromDir(pluginDir: string): Promise<PluginDefinition | null> {
  const manifestPath = path.join(pluginDir, "plugin.json");
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch {
    return null;
  }

  let manifest: PluginManifest;
  try {
    manifest = JSON.parse(raw) as PluginManifest;
  } catch (err) {
    logger().warn(COMPONENT, "plugin.manifest.parse-error", {
      data: { path: manifestPath, error: (err as Error).message },
    });
    return null;
  }

  const validation = validateManifest(manifest);
  if (!validation.valid) {
    logger().warn(COMPONENT, "plugin.manifest.invalid", {
      data: { path: manifestPath, errors: validation.errors },
    });
    return null;
  }

  const entryFile = manifest.entry ?? "index.js";
  const entryPath = path.join(pluginDir, entryFile);

  // eval('require') escapes webpack's static analyzer — it won't trace through
  // eval(), so the dynamic entryPath never triggers a "Can't resolve <dynamic>"
  // build error. At runtime this is just the real Node.js require().
  // eslint-disable-next-line no-eval
  const nodeRequire = eval("require") as NodeRequire;
  let mod: { default?: PluginDefinition } & Record<string, unknown>;
  try {
    mod = nodeRequire(entryPath) as typeof mod;
  } catch (err) {
    logger().warn(COMPONENT, "plugin.load-error", {
      data: { id: manifest.id, path: entryPath, error: (err as Error).message },
    });
    return null;
  }

  // Support both `export default { ... }` and `module.exports = { ... }` patterns.
  const def = (mod.default ?? mod) as PluginDefinition;
  if (!def || typeof def !== "object") {
    logger().warn(COMPONENT, "plugin.invalid-export", {
      data: { id: manifest.id, path: entryPath },
    });
    return null;
  }

  // Ensure the manifest is attached.
  def.manifest = manifest;

  return { manifest, hooks: def.hooks ?? {}, initialize: def.initialize, dispose: def.dispose, getConfig: def.getConfig, setConfig: def.setConfig };
}

/** Load all plugins from dataDir()/plugins/ and register active ones. */
export async function loadAllPlugins(): Promise<void> {
  // Migrate legacy config files before loading plugins.
  await migrateLegacyPluginConfigs();

  const dir = pluginsDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    // No plugins directory yet — nothing to load.
    return;
  }

  const config = await readPluginsConfig();
  const activeSet = new Set(config.active);

  for (const entry of entries) {
    const pluginDir = path.join(dir, entry);
    const stat = await fs.stat(pluginDir).catch(() => null);
    if (!stat?.isDirectory()) continue;

    const def = await loadPluginFromDir(pluginDir);
    if (!def) continue;

    // Register all loaded plugins (even inactive ones) so the UI can see them.
    registerPlugin(def);

    // Initialize active plugins.
    if (activeSet.has(def.manifest.id)) {
      const ctx: PluginContext = {
        dataDir: dataDir(),
        readFile: async (rel: string) => fs.readFile(path.join(pluginDir, rel), "utf8"),
        writeFile: async (rel: string, content: string) => {
          const fullPath = path.join(pluginDir, rel);
          await fs.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.writeFile(fullPath, content, "utf8");
        },
        readTranscript: async (convId: string) => {
          const { loadConversationMessages } = await import("@/lib/assistant/conversation-store");
          return loadConversationMessages(convId);
        },
        log: (level, msg, data) => {
          logger().log({ level, component: `${COMPONENT}.${def.manifest.id}`, msg, ...(data ? { data } : {}) });
        },
      };
      setPluginContext(def.manifest.id, ctx);

      if (def.initialize) {
        try {
          await def.initialize(ctx);
        } catch (err) {
          logger().error(COMPONENT, `plugin.initialize failed: ${def.manifest.id}`, undefined, {
            error: (err as Error).message,
          });
        }
      }
    }
  }

  logger().info(COMPONENT, "plugins.loaded", {
    data: {
      total: entries.length,
      active: config.active.length,
    },
  });
}

/** Install a plugin from a source directory (copies to plugins/<id>/). */
export async function installPlugin(sourceDir: string, manifest: PluginManifest): Promise<void> {
  const dest = path.join(pluginsDir(), manifest.id);
  await fs.mkdir(dest, { recursive: true });

  // Copy all files from source to destination.
  const files = await fs.readdir(sourceDir);
  for (const file of files) {
    const src = path.join(sourceDir, file);
    const dst = path.join(dest, file);
    const stat = await fs.stat(src);
    if (stat.isDirectory()) {
      await fs.cp(src, dst, { recursive: true });
    } else {
      await fs.copyFile(src, dst);
    }
  }

  // Ensure plugin.json is written.
  await fs.writeFile(path.join(dest, "plugin.json"), JSON.stringify(manifest, null, 2), "utf8");
}

/** Uninstall a plugin (remove its directory and deactivate). */
export async function uninstallPlugin(id: string): Promise<void> {
  const { deactivatePlugin } = await import("./registry");
  await deactivatePlugin(id);

  const dir = path.join(pluginsDir(), id);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Best-effort removal.
  }
}
