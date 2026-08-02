import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { itemLinkPath, itemConfigDir, isItemInstalled, RESERVED_ITEM_IDS } from "@/system/items/installed";

/**
 * Installing = ONE symlink, plus seeding config (035-install-by-symlink).
 *
 *   dataDir()/system/<item-id>        -> the item directory (marketplace clone or user-apps/items)
 *   dataDir()/system/config/<item-id> -> a REAL directory, copied from the item's config/ defaults
 *
 * Nothing else is created and no item content is copied. This replaces the
 * previous six-symlinks-per-item scheme (`system/services`, `system/app`,
 * `system/hooks`, `config/<id>`, `specs/external-specs/<id>`,
 * `docs/external-docs/<id>`) — two of which had no readers at all.
 *
 * Config is the single permitted copy, and only because it is mutable STATE
 * rather than content: a service writes `runtime.json` into its config directory
 * when it binds a port, and that must never land inside a read-only marketplace
 * clone that BOS later `git pull`s.
 */

async function pathExists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}

function wrapFsError(err: unknown, action: string, target: string): Error {
  const e = err as NodeJS.ErrnoException;
  if (e.code === "EACCES" || e.code === "EPERM") {
    return new Error(`Permission denied ${action} "${target}". Check filesystem permissions for dataDir() and retry.`);
  }
  return new Error(`Failed ${action} "${target}": ${e.message}`);
}

/**
 * Seed `system/config/<id>/` from the item's `config/` defaults.
 *
 * Never overwrites: on reinstall the user's existing settings win over the
 * item's defaults, and uninstall deliberately leaves this directory behind so a
 * reinstall keeps them.
 */
export async function seedItemConfig(itemPath: string, itemId: string): Promise<void> {
  const dest = itemConfigDir(itemId);
  if (await pathExists(dest)) return;

  const src = path.join(itemPath, "config");
  try {
    await fs.mkdir(dest, { recursive: true });
    if (await pathExists(src)) await fs.cp(src, dest, { recursive: true });
  } catch (err) {
    throw wrapFsError(err, "seeding config into", dest);
  }
}

/**
 * Install an item: create `system/<id>` → itemPath, then seed its config.
 * Idempotent — a re-install replaces the link and leaves existing config alone.
 */
export async function installItemLink(itemPath: string, itemId: string): Promise<void> {
  if (RESERVED_ITEM_IDS.has(itemId)) {
    throw new Error(`"${itemId}" is a reserved item id — dataDir()/system/${itemId}/ is used by BOS itself.`);
  }
  if (!(await pathExists(itemPath))) {
    throw new Error(`Cannot install "${itemId}": item directory does not exist: ${itemPath}`);
  }

  // Two marketplaces can offer the same item id, but the flat system/ namespace
  // holds only one. Refuse rather than silently rebinding an existing install.
  const link = itemLinkPath(itemId);
  const existing = await fs.readlink(link).catch(() => null);
  if (existing) {
    const resolved = path.resolve(path.dirname(link), existing);
    if (resolved !== path.resolve(itemPath)) {
      throw new Error(
        `"${itemId}" is already installed from a different source (${resolved}). ` +
        `Uninstall it first if you want to install this one instead.`,
      );
    }
  }

  try {
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.rm(link, { force: true });
    await fs.symlink(path.resolve(itemPath), link, "dir");
  } catch (err) {
    throw wrapFsError(err, "creating item symlink at", link);
  }

  await seedItemConfig(itemPath, itemId);
}

/**
 * Uninstall: remove the one symlink. Seeded config is intentionally kept, so
 * reinstalling preserves the user's settings.
 */
export async function uninstallItemLink(itemId: string): Promise<void> {
  try {
    await fs.rm(itemLinkPath(itemId), { force: true });
  } catch (err) {
    throw wrapFsError(err, "removing item symlink at", itemLinkPath(itemId));
  }
}

/** True when `dataDir()/system/<id>` exists — the definition of "installed". */
export async function isInstalled(itemId: string): Promise<boolean> {
  return isItemInstalled(itemId);
}

// ── Transitional aliases ──────────────────────────────────────────────────────
// The app surface still speaks in terms of "the app's symlink". Under 035 an
// app has no symlink of its own — its item does — so these map onto the item
// link. Kept as named aliases (rather than rewriting every call site at once)
// because the app registry's uninstall/restore semantics need a decision of
// their own: with one link per item, "uninstalled but still listed" no longer
// has a representation.

/** Install the item that carries this app. */
export async function createAppSymlink(itemPath: string, itemId: string): Promise<void> {
  await installItemLink(itemPath, itemId);
}

/** Uninstall the item that carries this app. */
export async function removeAppSymlink(itemId: string): Promise<void> {
  await uninstallItemLink(itemId);
}
