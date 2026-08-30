import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";

/**
 * The installed-item registry (035-install-by-symlink).
 *
 * Installed state is ONE symlink per item:
 *
 *   dataDir()/system/<item-id>  ->  dataDir()/marketplace/<mktId>/items/<item-id>
 *                                or dataDir()/user-apps/items/<item-id>
 *
 * Facets are found by a depth-2 scan: depth 1 enumerates the symlinks, depth 2
 * looks inside each item for `app/`, `services/service.json`, `plugin/bos-plugin.json`,
 * `spec/`, `hooks/`, `docs/`.
 *
 * This is the ONLY implementation of that scan. The app registry, the service
 * registry and the plugin loader all consume it (FR-007). Three subsystems
 * independently scanning the install root is precisely how the previous
 * divergence arose — the service registry scanned `user-apps` flat while the
 * marketplace client scanned `items/`, and they silently disagreed about what
 * existed. One scanner, one truth.
 */

/** Reserved: dataDir()/system/config/ shares the flat namespace with item symlinks. */
export const RESERVED_ITEM_IDS = new Set(["config"]);

/** `root` overrides the data root for a write that belongs to a FEATURE BRANCH:
 *  on base that is the branch's data clone, not this process's live root (see
 *  lib/devharness/branch-data-root.ts). It defaults to `dataDir()`, so every
 *  read path and every unbranded write is unchanged. */
export const systemRoot = (root?: string) => path.join(root ?? dataDir(), "system");
/** The single symlink that records "this item is installed". */
export const itemLinkPath = (id: string, root?: string) => path.join(systemRoot(root), id);
/** BOS-owned mutable config, seeded from the item's defaults at install. */
export const itemConfigDir = (id: string, root?: string) => path.join(systemRoot(root), "config", id);

/**
 * An item path reduced to its PROVENANCE — the part that identifies where the
 * item comes from, independent of which data root it sits in:
 * `user-apps/items/<id>` or `marketplace/<mktId>/items/<id>`.
 *
 * Install collisions must be judged on this, not on absolute paths. A feature
 * branch's data clone inherits base's `system/<id>` symlinks verbatim, and they
 * are ABSOLUTE — so the clone's link for an already-installed item points back
 * into base. Comparing absolute paths then reads "same item, pre-branch copy"
 * as "installed from a different source" and refuses the install outright,
 * which made updating ANY already-installed item on a feature branch
 * impossible: uninstalling in base could not clear it either, because the
 * clone keeps its own copy of the link.
 *
 * A genuine conflict — the same id offered by a different marketplace — still
 * differs in this key and is still refused.
 */
export function itemProvenanceKey(absItemPath: string, roots: string[]): string {
  for (const root of roots) {
    if (!root) continue;
    const rel = path.relative(root, absItemPath);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel.split(path.sep).join("/");
  }
  // Not under any known data root — compare absolutely rather than guessing.
  return path.resolve(absItemPath);
}

export interface ItemFacets {
  app: boolean;
  service: boolean;
  plugin: boolean;
  spec: boolean;
  hooks: boolean;
  /** `docs/usage/**` + `docs/dev/**` — the item's own documentation, overlaid
   *  into the Docs app's tree by @/lib/docs/store (no second symlink). */
  docs: boolean;
}

export interface InstalledItem {
  id: string;
  /** Absolute, symlink-resolved path to the item directory. */
  itemPath: string;
  facets: ItemFacets;
  /** Derived from where the symlink resolves — never stored (FR-009). */
  origin: "local" | "marketplace";
  /** Present only for marketplace-sourced items. */
  marketplaceId?: string;
  /** True when the symlink target no longer exists. Reported, never dropped. */
  broken: boolean;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readFacets(itemPath: string): Promise<ItemFacets> {
  const [app, service, plugin, spec, hooks, docs] = await Promise.all([
    // An app is `app/` — either an index.html or just an app.json, the latter
    // being a plugin-served app whose files are served by its plugin.
    exists(path.join(itemPath, "app")),
    exists(path.join(itemPath, "services", "service.json")),
    exists(path.join(itemPath, "plugin", "bos-plugin.json")),
    exists(path.join(itemPath, "spec")),
    exists(path.join(itemPath, "hooks")),
    exists(path.join(itemPath, "docs")),
  ]);
  return { app, service, plugin, spec, hooks, docs };
}

/**
 * Where an item's symlink resolves determines its provenance (FR-009) — nothing
 * is persisted. `user-apps/items/<id>` is the user's own work; anything under
 * `marketplace/<mktId>/items/<id>` came from that marketplace.
 */
function deriveOrigin(resolved: string): { origin: "local" | "marketplace"; marketplaceId?: string } {
  const userApps = path.join(dataDir(), "user-apps") + path.sep;
  const marketplaces = path.join(dataDir(), "marketplace") + path.sep;
  if (resolved.startsWith(userApps)) return { origin: "local" };
  if (resolved.startsWith(marketplaces)) {
    const [marketplaceId] = path.relative(path.join(dataDir(), "marketplace"), resolved).split(path.sep);
    return { origin: "marketplace", marketplaceId: marketplaceId || undefined };
  }
  // Installed from somewhere unexpected — treat as untrusted.
  return { origin: "marketplace" };
}

/** Every installed item, with its facets and derived provenance. */
export async function listInstalledItems(dataRoot?: string): Promise<InstalledItem[]> {
  const root = systemRoot(dataRoot);
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[]);
  const items: InstalledItem[] = [];

  for (const entry of entries) {
    if (RESERVED_ITEM_IDS.has(entry.name)) continue;
    const link = path.join(root, entry.name);

    // Resolve the link ourselves rather than trusting Dirent: an install is a
    // symlink, so readdir reports DT_LNK, and a broken one must still surface.
    let target: string;
    try {
      target = await fs.readlink(link);
    } catch {
      // Not a symlink. Pre-035 layouts had real directories here (`app/`,
      // `services/`); the migration removes them, so anything left is foreign.
      continue;
    }
    const itemPath = path.resolve(path.dirname(link), target);
    const broken = !(await exists(itemPath));

    items.push({
      id: entry.name,
      itemPath,
      facets: broken
        ? { app: false, service: false, plugin: false, spec: false, hooks: false, docs: false }
        : await readFacets(itemPath),
      ...deriveOrigin(itemPath),
      broken,
    });
  }
  return items;
}

/** One installed item, or null. `dataRoot` scopes the lookup to a FEATURE
 *  BRANCH's data clone instead of the live root — an install targeting a branch
 *  must collision-check against what is installed THERE, not in base. */
export async function getInstalledItem(id: string, dataRoot?: string): Promise<InstalledItem | null> {
  return (await listInstalledItems(dataRoot)).find((i) => i.id === id) ?? null;
}

export async function isItemInstalled(id: string): Promise<boolean> {
  try {
    await fs.readlink(itemLinkPath(id));
    return true;
  } catch {
    return false;
  }
}

/** Installed items sourced from a given marketplace — used to refuse its removal (FR-012). */
export async function itemsFromMarketplace(marketplaceId: string): Promise<InstalledItem[]> {
  return (await listInstalledItems()).filter((i) => i.marketplaceId === marketplaceId);
}
