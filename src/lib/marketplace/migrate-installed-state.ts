import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { logger } from "@/lib/logging";
import { itemLinkPath, itemConfigDir } from "@/system/items/installed";

const COMPONENT = "marketplace.migrate-installed";

/**
 * Migrate pre-035 installed state to one-symlink-per-item (035 FR-010).
 *
 * Before: up to six symlinks per item —
 *   system/services/<id>, system/app/<id>, system/hooks/<id>, system/settings/<id>,
 *   config/<id>, specs/external-specs/<id>, docs/external-docs/<id>
 * After:
 *   system/<id>            -> the item directory
 *   system/config/<id>/    -> a REAL directory holding the item's live config
 *
 * The config step is the one that must not be got wrong: `configDirPath` moved to
 * `system/config/<id>`, so without seeding it from the OLD location a service
 * would start with no config and fail to write `runtime.json` — which silently
 * breaks anything that resolves a service's port (the Terminal app's WebSocket,
 * for one). We therefore copy from the old `config/<id>` symlink target when it
 * exists, falling back to the item's packaged defaults.
 *
 * It also folds `data/bos-plugins/<id>/` back into its item as a `plugin/` facet
 * (035 FR-008/FR-010). Those directories were COPIES; a plugin install used to
 * leave the item itself a stub, so simply deleting them would stop the plugin
 * loading. When the item is the user's own we move the copy in, repairing the
 * half-item; when it already has a `plugin/` facet we just drop the copy.
 *
 * Idempotent, and never deletes item content.
 */

const LEGACY_FACET_DIRS = ["services", "app", "hooks", "settings"] as const;

async function readlinkOrNull(p: string): Promise<string | null> {
  try {
    return path.resolve(path.dirname(p), await fs.readlink(p));
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}

/** Legacy per-facet link paths for one id, plus the two unused trees. */
function legacyLinks(id: string): string[] {
  return [
    ...LEGACY_FACET_DIRS.map((f) => path.join(dataDir(), "system", f, id)),
    path.join(dataDir(), "config", id),
    path.join(dataDir(), "specs", "external-specs", id),
    path.join(dataDir(), "docs", "external-docs", id),
  ];
}

export interface InstalledStateMigrationResult {
  migrated: string[];
  configSeeded: string[];
  pluginsFolded: string[];
}

export async function migrateInstalledState(): Promise<InstalledStateMigrationResult> {
  const result: InstalledStateMigrationResult = { migrated: [], configSeeded: [], pluginsFolded: [] };
  const systemDir = path.join(dataDir(), "system");

  // Collect every id that has a legacy facet symlink, and the item it points at.
  // The item directory is the PARENT of the facet the link targets.
  const itemPathById = new Map<string, string>();
  for (const facet of LEGACY_FACET_DIRS) {
    const facetDir = path.join(systemDir, facet);
    for (const id of await fs.readdir(facetDir).catch(() => [] as string[])) {
      if (itemPathById.has(id)) continue;
      const target = await readlinkOrNull(path.join(facetDir, id));
      if (target) itemPathById.set(id, path.dirname(target));
    }
  }
  const hadFacetLinks = itemPathById.size > 0;

  for (const [id, itemPath] of itemPathById) {
    // 1. Seed config BEFORE removing the old link, since that link is how we
    //    find the live config.
    const dest = itemConfigDir(id);
    if (!(await exists(dest))) {
      const legacyConfigLink = path.join(dataDir(), "config", id);
      const legacyConfig = (await readlinkOrNull(legacyConfigLink)) ?? legacyConfigLink;
      const source = (await exists(legacyConfig)) ? legacyConfig : path.join(itemPath, "config");
      if (await exists(source)) {
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.cp(source, dest, { recursive: true });
        result.configSeeded.push(id);
      }
    }

    // 2. The single item symlink.
    if (await exists(itemPath)) {
      const link = itemLinkPath(id);
      await fs.rm(link, { force: true });
      await fs.symlink(itemPath, link, "dir");
      result.migrated.push(id);
    } else {
      logger().warn(COMPONENT, `item for "${id}" no longer exists — leaving it uninstalled`, { id, itemPath });
    }

    // 3. Drop every legacy link for this id.
    for (const link of legacyLinks(id)) await fs.rm(link, { force: true, recursive: false }).catch(() => undefined);
  }

  // 4. Remove the emptied facet directories (rmdir fails if anything remains,
  //    which is the behaviour we want — never delete unexpected content).
  for (const facet of LEGACY_FACET_DIRS) {
    await fs.rmdir(path.join(systemDir, facet)).catch(() => undefined);
  }
  await fs.rmdir(path.join(dataDir(), "specs", "external-specs")).catch(() => undefined);
  await fs.rmdir(path.join(dataDir(), "docs", "external-docs")).catch(() => undefined);

  await foldBosPlugins(result);

  if (hadFacetLinks || result.pluginsFolded.length > 0) {
    logger().info(COMPONENT, "migrated installed state to one-symlink-per-item", {
      migrated: result.migrated,
      configSeeded: result.configSeeded,
      pluginsFolded: result.pluginsFolded,
    });
  }
  return result;
}

/**
 * Fold `data/bos-plugins/<id>/` into its item as a `plugin/` facet, then retire
 * that directory. Only ever moves INTO the user's own item (a marketplace clone
 * is not ours to write to); otherwise the copy is dropped, since the marketplace
 * item already carries the real `plugin/`.
 */
async function foldBosPlugins(result: InstalledStateMigrationResult): Promise<void> {
  const legacyRoot = path.join(dataDir(), "bos-plugins");
  const ids = await fs.readdir(legacyRoot).catch(() => [] as string[]);

  for (const id of ids) {
    const copy = path.join(legacyRoot, id);
    if (!(await exists(path.join(copy, "bos-plugin.json")))) continue;

    // Where the item lives: the existing install link, else the user's own repo.
    const linked = await readlinkOrNull(itemLinkPath(id));
    const itemPath = linked ?? path.join(dataDir(), "user-apps", "items", id);
    const facet = path.join(itemPath, "plugin");

    if (!(await exists(facet))) {
      const isUserOwned = itemPath.startsWith(path.join(dataDir(), "user-apps") + path.sep);
      if (isUserOwned) {
        await fs.mkdir(itemPath, { recursive: true });
        await fs.rename(copy, facet);
        // The plugin now lives in the user's own marketplace repo — commit it, or
        // it sits there untracked and a later `git reset` would lose it.
        const { commitAll } = await import("@/lib/gitfs/store");
        await commitAll(path.join(dataDir(), "user-apps"), `fold ${id} plugin into its item`).catch(() => undefined);
        result.pluginsFolded.push(id);
      } else {
        logger().warn(COMPONENT, `plugin "${id}" has no plugin/ facet in ${itemPath} — leaving the legacy copy in place`, { id, itemPath });
        continue;
      }
    }

    // Make sure it is installed, then drop any remaining copy.
    if (await exists(itemPath)) {
      await fs.rm(itemLinkPath(id), { force: true });
      await fs.symlink(itemPath, itemLinkPath(id), "dir");
    }
    await fs.rm(copy, { recursive: true, force: true }).catch(() => undefined);
  }

  await fs.rmdir(legacyRoot).catch(() => undefined);
}
