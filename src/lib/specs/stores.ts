import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { specsRoot } from "@/os/specs-dir";
import { listItemStores } from "@/lib/specs/item-stores";
import type { StoreOwner } from "./types";

// Spec-store discovery (018-external-spec-store). Stores are discovered by
// LISTING the container root — there is NO central registry file (same rule as
// installed apps). A subdirectory is a store iff it has BOTH its own `.git` and a
// `spec-store.json` manifest. A store's role/policy come from its manifest, not
// its directory name, so a cloned marketplace repo brings its own identity.

// StoreOwner is the single source of truth in ./types.ts (framework-free, safe
// for client code too) — re-exported here so existing server-side imports of
// it from "./stores" keep working without a second, hand-synced declaration.
export type { StoreOwner };

export const STORE_MANIFEST = "spec-store.json";
/** Marks a directory-scanned store's top-level subfolder as a Project (033).
 *  Lives here (not projects.ts) so both stores.ts's consumers and
 *  dev/spec-fs.ts can import it without a projects.ts <-> spec-fs.ts cycle. */
export const PROJECT_MANIFEST = "project.json";

export interface StoreManifest {
  /** Human label shown as the Build Studio group name. */
  label: string;
  owner: StoreOwner;
  /** Whether spec-fs may write to this store at all. */
  writable: boolean;
  /** Retained as metadata (020): review happens on feature branches coupled to
   *  the code promote; writes commit-on-save regardless of this flag. */
  requiresPromote: boolean;
}

export interface SpecStore extends StoreManifest {
  /** Subdirectory name under the container root (the store id). */
  id: string;
  /** Absolute path to the store's content root — what spec-fs jails paths to. */
  root: string;
  /** Absolute path to the GIT REPO that versions this store's content. Equal to
   *  `root` for a directory-scanned store (which is its own repo root), but NOT
   *  for an item-owned store, whose root is `user-apps/items/<id>/spec` — a
   *  subdirectory of the shared `user-apps` repo. Anything addressing git by
   *  repo (history listing, `git show <ref>:<path>`, which resolves paths
   *  relative to the repo root) must use this, not `root`. */
  repoRoot: string;
  /** Set only for `owner: "item"` stores: "local" or the source
   *  marketplace's display name (item-stores.ts). */
  originLabel?: string;
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function readManifest(dir: string): Promise<StoreManifest | null> {
  try {
    const raw = await fs.readFile(path.join(dir, STORE_MANIFEST), "utf8");
    const m = JSON.parse(raw) as Partial<StoreManifest>;
    const owner: StoreOwner =
      m.owner === "system" || m.owner === "user" || m.owner === "marketplace" ? m.owner : "marketplace";
    return {
      label: typeof m.label === "string" ? m.label.trim() : "",
      owner,
      // Marketplaces default to read-only; system/user must opt in explicitly.
      writable: m.writable === true,
      requiresPromote: m.requiresPromote === true,
    };
  } catch {
    return null;
  }
}

/** Discover the active spec stores under the container root, ordered
 *  system → user → marketplace → item, then by id. Missing root → no
 *  directory-scanned stores, but item-owned stores (installed items with a
 *  `spec/` facet — see item-stores.ts) are discovered independently and
 *  always merged in. */
export async function listStores(): Promise<SpecStore[]> {
  const root = specsRoot();
  let entries: import("fs").Dirent[] = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const stores: SpecStore[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const dir = path.join(root, e.name);
    if (!(await isGitRepo(dir))) continue;
    const manifest = await readManifest(dir);
    if (!manifest) continue;
    // A directory-scanned store IS its own repo root (isGitRepo(dir) above).
    stores.push({ id: e.name, root: dir, repoRoot: dir, ...manifest, label: manifest.label || e.name });
  }
  stores.push(...(await listItemStores()));
  const rank = (o: StoreOwner) => (o === "system" ? 0 : o === "user" ? 1 : o === "marketplace" ? 2 : 3);
  return stores.sort((a, b) => rank(a.owner) - rank(b.owner) || a.id.localeCompare(b.id));
}

export async function getStore(id: string): Promise<SpecStore | undefined> {
  return (await listStores()).find((s) => s.id === id);
}

/** The default target for NEW user specs: the writable user store, else any writable store. */
export async function defaultWritableStore(): Promise<SpecStore | undefined> {
  const stores = await listStores();
  return stores.find((s) => s.owner === "user" && s.writable) ?? stores.find((s) => s.writable);
}
