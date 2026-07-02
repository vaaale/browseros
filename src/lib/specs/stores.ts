import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { specsRoot } from "@/os/specs-dir";

// Spec-store discovery (018-external-spec-store). Stores are discovered by
// LISTING the container root — there is NO central registry file (same rule as
// installed apps). A subdirectory is a store iff it has BOTH its own `.git` and a
// `spec-store.json` manifest. A store's role/policy come from its manifest, not
// its directory name, so a cloned marketplace repo brings its own identity.

export type StoreOwner = "system" | "user" | "marketplace";

export const STORE_MANIFEST = "spec-store.json";

export interface StoreManifest {
  /** Human label shown as the Build Studio group name. */
  label: string;
  owner: StoreOwner;
  /** Whether spec-fs may write to this store at all. */
  writable: boolean;
  /** Whether writes go through a candidate branch + promote (vs commit-on-save). */
  requiresPromote: boolean;
}

export interface SpecStore extends StoreManifest {
  /** Subdirectory name under the container root (the store id). */
  id: string;
  /** Absolute path to the store repo. */
  root: string;
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
 *  system → user → marketplace, then by id. Missing root → no stores. */
export async function listStores(): Promise<SpecStore[]> {
  const root = specsRoot();
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const stores: SpecStore[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const dir = path.join(root, e.name);
    if (!(await isGitRepo(dir))) continue;
    const manifest = await readManifest(dir);
    if (!manifest) continue;
    stores.push({ id: e.name, root: dir, ...manifest, label: manifest.label || e.name });
  }
  const rank = (o: StoreOwner) => (o === "system" ? 0 : o === "user" ? 1 : 2);
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
