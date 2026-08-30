import "server-only";
import path from "path";
import { promises as fs } from "fs";
import { dataDir } from "@/os/data-dir";
import type { InstalledItem } from "@/system/items/installed";
import { getItemDisplayName, getItemOriginLabel } from "@/lib/marketplace/item-manifest";
import type { SpecStore } from "./stores";

// Item-owned spec stores: EVERY subfolder of user-apps/items/ is discoverable
// as its own spec store, rooted at the item's `spec/` subfolder itself — NOT
// the item's top-level folder — so its `app/`/`services/`/`plugin/` siblings
// stay physically unreachable through spec-fs. This is a real filesystem
// jail, not a listing filter.
//
// No facet check gates this: an item with no `app/` and no `spec/` yet (e.g.
// a bare scaffold, or a marketplace clone with only a README so far) still
// gets a store here, just an empty one — spec-fs.writeFile() `mkdir -p`s the
// `spec/` folder on first save, so "nothing written yet" must not mean
// "invisible in Build Studio".
//
// LOCAL items only, discovered by scanning `user-apps/items/` DIRECTLY —
// deliberately NOT gated on install state (data/system/<id> symlink). An item
// already lives in the user's own git-tracked `user-apps` repo the moment it's
// cloned/created there; requiring it to also be installed (registered as a
// runnable app) before its spec becomes editable conflates two unrelated
// concerns. A marketplace clone's items are excluded on the same "lives in MY
// user-apps repo" basis as before — editing them here could never be
// committed (there's no user-owned branch on that repo).
//
// An item store's root is a subdirectory of the ALREADY-INITIALIZED
// `user-apps` repo, not a repo root of its own — store-git.ts's
// commitOnSave() accounts for that (commitScoped vs commitAll).
//
// Deliberately imports item-manifest.ts, NOT marketplace/client.ts: client.ts
// statically imports spec-mount.ts (for userSpecRoot), which reaches back into
// stores.ts (for STORE_MANIFEST) — since stores.ts imports THIS file, a static
// import of client.ts here would close a real circular-dependency chain.
// item-manifest.ts is a standalone, read-only module with no path back to
// stores.ts, purpose-built to break that cycle.

/** `item-<itemId>` rather than a colon-separated id: getSpecification()'s
 *  path sanitizer strips anything outside [a-zA-Z0-9._/-], which would
 *  silently mangle a `:` separator. */
export const ITEM_STORE_PREFIX = "item-";

const userAppsItemsDir = () => path.join(dataDir(), "user-apps", "items");

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function listItemStores(): Promise<SpecStore[]> {
  const root = userAppsItemsDir();
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [] as import("fs").Dirent[]);
  const stores: SpecStore[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const itemPath = path.join(root, entry.name);
    const [app, spec] = await Promise.all([
      pathExists(path.join(itemPath, "app")),
      pathExists(path.join(itemPath, "spec")),
    ]);

    const item: InstalledItem = {
      id: entry.name,
      itemPath,
      facets: { app, service: false, plugin: false, spec, hooks: false, docs: false },
      origin: "local",
      broken: false,
    };
    const [label, originLabel] = await Promise.all([getItemDisplayName(item), getItemOriginLabel(item)]);
    stores.push({
      id: `${ITEM_STORE_PREFIX}${item.id}`,
      root: path.join(itemPath, "spec"),
      // The shared `user-apps` repo, NOT the item's `spec/` folder — that
      // folder has no `.git` of its own, so anything that addresses git by
      // repo (history, `git show <ref>:<path>`) must start here.
      repoRoot: path.join(dataDir(), "user-apps"),
      label,
      owner: "item",
      writable: true, // always local — a marketplace-sourced item never reaches here
      requiresPromote: false,
      originLabel,
    });
  }
  return stores;
}
