import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { logger } from "@/lib/logging";
import { commitAll } from "@/lib/gitfs/store";

const COMPONENT = "marketplace.migrate";

/**
 * One-shot migration to the marketplace layout (034 FR-008).
 *
 * `dataDir()/user-apps/` used to hold items flat at its root; it now holds a
 * `marketplace.json` plus `items/<id>/`, identical to any marketplace clone.
 *
 * The part that must not be forgotten: installed state is a set of ABSOLUTE
 * symlinks into the old locations (`dataDir()/system/app/<id>` →
 * `…/user-apps/<id>/app`, and the same for services/settings/hooks plus
 * `dataDir()/config/<id>`). Moving the directories without re-pointing those
 * leaves every installed item dangling — the service registry sees a broken
 * install and the app 404s.
 *
 * Idempotent: a repo already in the new shape is left alone.
 */

/** Directories that mark a top-level entry as an ITEM rather than repo furniture. */
const ITEM_MARKERS = ["services", "app", "spec", "doc", "hooks", "settings", "config"];

/** Every place an installed item is symlinked from, mirroring symlinkManager. */
function linkPathsFor(id: string): string[] {
  return [
    path.join(dataDir(), "system", "services", id),
    path.join(dataDir(), "system", "app", id),
    path.join(dataDir(), "system", "settings", id),
    path.join(dataDir(), "system", "hooks", id),
    path.join(dataDir(), "config", id),
    path.join(dataDir(), "specs", "external-specs", id),
    path.join(dataDir(), "docs", "external-docs", id),
  ];
}

async function isItemDir(dir: string): Promise<boolean> {
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  return entries.some((e) => ITEM_MARKERS.includes(e));
}

/**
 * Re-point one symlink from the old flat target to the new items/ target.
 * Only rewrites links that actually point into `oldItemDir`, so a link the user
 * redirected somewhere else by hand is left alone.
 */
async function repointLink(linkPath: string, oldItemDir: string, newItemDir: string): Promise<boolean> {
  let current: string;
  try {
    current = await fs.readlink(linkPath);
  } catch {
    return false; // absent, or a real directory rather than a symlink
  }
  const resolved = path.resolve(path.dirname(linkPath), current);
  if (resolved !== oldItemDir && !resolved.startsWith(oldItemDir + path.sep)) return false;

  const suffix = path.relative(oldItemDir, resolved);
  const next = suffix ? path.join(newItemDir, suffix) : newItemDir;
  await fs.rm(linkPath, { force: true });
  await fs.mkdir(path.dirname(linkPath), { recursive: true });
  await fs.symlink(next, linkPath);
  return true;
}

export interface UserAppsMigrationResult {
  migrated: string[];
  relinked: number;
}

export async function migrateUserAppsLayout(): Promise<UserAppsMigrationResult> {
  const root = path.join(dataDir(), "user-apps");
  const itemsDir = path.join(root, "items");
  const result: UserAppsMigrationResult = { migrated: [], relinked: 0 };

  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => null);
  if (!entries) return result; // no user-apps yet — nothing to migrate

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "items" || entry.name === ".git") continue;
    const oldItemDir = path.join(root, entry.name);
    if (!(await isItemDir(oldItemDir))) continue;

    const newItemDir = path.join(itemsDir, entry.name);
    if (await fs.stat(newItemDir).then(() => true).catch(() => false)) {
      logger().warn(COMPONENT, `skipping "${entry.name}" — it already exists under items/`, { id: entry.name });
      continue;
    }

    await fs.mkdir(itemsDir, { recursive: true });
    await fs.rename(oldItemDir, newItemDir);
    result.migrated.push(entry.name);

    for (const link of linkPathsFor(entry.name)) {
      if (await repointLink(link, oldItemDir, newItemDir)) result.relinked += 1;
    }
  }

  if (result.migrated.length > 0) {
    logger().info(COMPONENT, `migrated user-apps to items/ layout`, {
      items: result.migrated,
      relinked: result.relinked,
    });
    await commitAll(root, `migrate to items/ layout (${result.migrated.length} item(s))`).catch(() => undefined);
  }
  return result;
}
