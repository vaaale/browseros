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
 * `spec/`, `hooks/`.
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

export const systemRoot = () => path.join(dataDir(), "system");
/** The single symlink that records "this item is installed". */
export const itemLinkPath = (id: string) => path.join(systemRoot(), id);
/** BOS-owned mutable config, seeded from the item's defaults at install. */
export const itemConfigDir = (id: string) => path.join(systemRoot(), "config", id);

export interface ItemFacets {
  app: boolean;
  service: boolean;
  plugin: boolean;
  spec: boolean;
  hooks: boolean;
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
  const [app, service, plugin, spec, hooks] = await Promise.all([
    // An app is `app/` — either an index.html or just an app.json, the latter
    // being a plugin-served app whose files are served by its plugin.
    exists(path.join(itemPath, "app")),
    exists(path.join(itemPath, "services", "service.json")),
    exists(path.join(itemPath, "plugin", "bos-plugin.json")),
    exists(path.join(itemPath, "spec")),
    exists(path.join(itemPath, "hooks")),
  ]);
  return { app, service, plugin, spec, hooks };
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
export async function listInstalledItems(): Promise<InstalledItem[]> {
  const root = systemRoot();
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
        ? { app: false, service: false, plugin: false, spec: false, hooks: false }
        : await readFacets(itemPath),
      ...deriveOrigin(itemPath),
      broken,
    });
  }
  return items;
}

/** One installed item, or null. */
export async function getInstalledItem(id: string): Promise<InstalledItem | null> {
  return (await listInstalledItems()).find((i) => i.id === id) ?? null;
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
