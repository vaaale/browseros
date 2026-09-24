import "server-only";
import path from "path";
import { promises as fs } from "fs";
import { dataDir } from "@/os/data-dir";
import type { InstalledItem } from "@/system/items/installed";
import { getItemDisplayName, getItemOriginLabel } from "@/lib/marketplace/item-manifest";
import { supervisorEnabled, supervisorBeginOrThrow } from "@/lib/devharness/supervisor";
import { logger } from "@/lib/logging/server-logger";
import { STORE_MANIFEST, type SpecStore } from "./stores";

const COMPONENT = "specs.item-stores";

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

/** The same `items/` folder inside the user-apps checkout COUPLED TO A BRANCH,
 *  or null when this branch has no such checkout.
 *
 *  THE BUG THIS EXISTS FOR: an app being created is written to the branch's
 *  user-apps clone, because every `app_spec_*` write is refused without a
 *  branch. Discovery scanned only `data/user-apps/items`, so a brand-new app —
 *  which by construction exists nowhere else yet — never appeared in Build
 *  Studio at all. The branch was real, the files were real, the agent reported
 *  success, and the tree was empty. Nothing errored: content was read through
 *  the branch while the SET of items came from base.
 *
 *  Null, not a throw, on every miss — item discovery is one part of a listing
 *  that must still serve the other stores. But never SILENTLY null: a branch
 *  that does not couple user-apps (a `bos-core` or `repository` scope) is the
 *  normal case and logged at debug; anything else is a condition someone has to
 *  see, and carries its real cause. */
async function branchItemsDir(branch: string): Promise<string | null> {
  // With no Supervisor there is no separate clone: the branch IS the base
  // checkout's current HEAD, so the canonical scan already sees its items.
  if (!branch || !supervisorEnabled()) return null;
  let clone: string;
  try {
    clone = (await supervisorBeginOrThrow(branch)).dataDir;
  } catch (err) {
    logger().warn(COMPONENT, "could not reach the branch's data clone; item discovery uses base only", {
      branch,
      err: String(err),
    });
    return null;
  }
  if (!clone) {
    logger().warn(COMPONENT, "Supervisor returned no data clone; item discovery uses base only", { branch });
    return null;
  }
  const dir = path.join(clone, "user-apps", "items");
  try {
    await fs.access(dir);
    return dir;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      logger().debug(COMPONENT, "branch does not couple user-apps; item discovery uses base only", { branch, dir });
    } else {
      logger().warn(COMPONENT, "branch's user-apps mount is unreadable", { branch, dir, code, err: String(err) });
    }
    return null;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** An item store's method binding, from `<item>/spec/spec-store.json`.
 *
 *  An item store is SYNTHESISED — it has no manifest of its own — so until this
 *  existed `store.method` was permanently undefined for every item and the
 *  binding chain could only ever land on the global default. The dropdown then
 *  showed a value it could not have read, which is worse than showing none.
 *
 *  The binding lives WITH the specs, inside the item's own `spec/` folder,
 *  rather than in BOS's per-install config: the method an item's specs are
 *  WRITTEN IN is a property of that content, so it must travel when the item is
 *  published and be identical for whoever installs it. Storing it per-install
 *  would let the same specs be read through a different framework on another
 *  machine. Only the BINDING is taken — an item's label and origin come from
 *  the item itself, and letting a stray manifest override them would be a way
 *  to spoof one item as another.
 *
 *  BOTH spellings, because the write side uses the other one. `setItemWorkflow`
 *  records `workflow` (051: a workflow supersedes a bare method) and this read
 *  only ever looked at `method` — so an item bound through Build Studio's own
 *  dialog wrote a key nothing read, and reported the global default forever
 *  after. The binding chain already resolves `workflow ?? method`
 *  (pipeline.ts); an item store simply never populated either one honestly. */
async function readItemBinding(itemPath: string): Promise<{ workflow?: string; method?: string }> {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  try {
    const raw = await fs.readFile(path.join(itemPath, "spec", STORE_MANIFEST), "utf8");
    const m = JSON.parse(raw) as { workflow?: unknown; method?: unknown };
    return { ...(str(m.workflow) ? { workflow: str(m.workflow) } : {}), ...(str(m.method) ? { method: str(m.method) } : {}) };
  } catch {
    // An item that has never been bound has no manifest at all — the common
    // case, and not an error. A malformed one is indistinguishable here and
    // resolves to the default, same as unbound.
    return {};
  }
}

async function itemDirNames(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [] as import("fs").Dirent[]);
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

/** Every item-owned spec store.
 *
 *  `branch` widens discovery to items that exist ONLY on that feature branch —
 *  an app being created, which cannot exist anywhere else yet. Base wins for an
 *  item present in both: its store is read exactly as before, so nothing about
 *  an installed item changes when a branch is active. (A rename made on the
 *  branch therefore still shows the base name until promote; that is a much
 *  smaller wrongness than the app not existing, and fixing it is a separate
 *  change to where item metadata is read from.)
 *
 *  Without a branch the base scan is the whole answer — a branch-only item is
 *  correctly absent, because off that branch the app genuinely does not exist. */
export async function listItemStores(branch?: string): Promise<SpecStore[]> {
  const root = userAppsItemsDir();
  const branchRoot = branch ? await branchItemsDir(branch) : null;
  /** id -> the directory it was found in. Base first, so it wins a collision. */
  const found = new Map<string, string>();
  for (const name of await itemDirNames(root)) found.set(name, root);
  if (branchRoot) {
    for (const name of await itemDirNames(branchRoot)) if (!found.has(name)) found.set(name, branchRoot);
  }
  const stores: SpecStore[] = [];

  for (const [name, foundIn] of found) {
    const itemPath = path.join(foundIn, name);
    // `<...>/user-apps/items` -> `<...>/user-apps`: the checkout this item was
    // actually found in, base or branch clone. Derived rather than hardcoded to
    // `dataDir()/user-apps`, so a branch-only item addresses the repo that
    // really holds it instead of one where its path does not exist.
    const userAppsRoot = path.dirname(foundIn);
    const [app, spec] = await Promise.all([
      pathExists(path.join(itemPath, "app")),
      pathExists(path.join(itemPath, "spec")),
    ]);

    const item: InstalledItem = {
      id: name,
      itemPath,
      facets: { app, service: false, plugin: false, spec, hooks: false, docs: false, method: false },
      origin: "local",
      broken: false,
    };
    const [label, originLabel, binding] = await Promise.all([
      // From the manifest of the checkout the item was found in — for a
      // branch-only app, base's manifest has never heard of it, and reading it
      // there would silently title-case the id instead of using the name the
      // app was created under.
      getItemDisplayName(item, userAppsRoot),
      getItemOriginLabel(item),
      readItemBinding(itemPath),
    ]);
    stores.push({
      id: `${ITEM_STORE_PREFIX}${item.id}`,
      root: path.join(itemPath, "spec"),
      // The shared `user-apps` repo, NOT the item's `spec/` folder — that
      // folder has no `.git` of its own, so anything that addresses git by
      // repo (history, `git show <ref>:<path>`) must start here.
      repoRoot: userAppsRoot,
      // `items/<id>/spec` within that repo. An item store is the ORIGINAL
      // subdirectory store; its offset was always implicit in
      // branchItemStoreRoot, and stating it keeps one rule for every store.
      repoOffset: path.join("items", item.id, "spec"),
      label,
      owner: "item",
      writable: true, // always local — a marketplace-sourced item never reaches here
      requiresPromote: false,
      originLabel,
      ...binding,
    });
  }
  return stores;
}
