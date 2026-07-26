import "server-only";
import path from "path";
import { listStores } from "@/lib/specs/stores";
import { dataDir } from "@/os/data-dir";
import { hasGitDir } from "./git-ops";
import { ensureRepo } from "@/lib/gitfs/store";

// Central registry of the GitFS instances configured in BOS. Any git-backed
// content root that supports external remotes is discovered here, so the
// Settings → Versions UI (and anything else) can list them WITHOUT a hand-kept
// registry file: if a new GitFS is added elsewhere (a new spec store, a future
// content root), it shows up automatically.
//
// Discovery mirrors the "list the container, no central registry" rule used by
// spec-store discovery (018) and installed-app discovery: we enumerate the known
// content roots and keep the ones that are actually their own git repository.

/** The id used for the BrowserOS source repo instance. Legacy remotes with no
 *  explicit `filesystem` tag belong to this instance. */
export const SOURCE_FS_ID = "bos-src";

export interface GitFsInstance {
  /** Stable id used as the `filesystem` tag on remote configs and as a query param. */
  id: string;
  /** Human label shown as the card title. */
  label: string;
  /** VFS-facing mount path shown as the card description (e.g. "/user-specs"). */
  vfsPath: string;
  /** Absolute path to the git repository backing this filesystem. */
  root: string;
}

/** Discover the GitFS instances currently configured in BOS. Ordered spec
 *  stores → installed apps → BrowserOS source. Never throws. */
export async function getAvailableGitFsInstances(): Promise<GitFsInstance[]> {
  const instances: GitFsInstance[] = [];

  // Spec stores — each is an independent git repo under BOS_SPECS_ROOT.
  try {
    for (const store of await listStores()) {
      instances.push({
        id: store.id,
        label: store.label,
        vfsPath: `/${store.id}`,
        root: store.root,
      });
    }
  } catch {
    // No spec stores discovered — fine.
  }

  // User apps GitFS (002-service-daemons) — the user's own local marketplace
  // AND the install target for every item, apps included (there is no separate
  // apps repo). Same concept as a spec store: BOS never populates or deletes
  // from it, only ensures it's a git repo (a no-op if the user already cloned
  // their own remote there).
  try {
    const userApps = path.join(dataDir(), "user-apps");
    await ensureRepo(userApps);
    if (await hasGitDir(userApps)) {
      instances.push({ id: "user-apps", label: "User Apps", vfsPath: "/user-apps", root: userApps });
    }
  } catch {
    // user-apps dir absent or not a repo — fine.
  }

  // BrowserOS source repo (the checkout BOS itself runs from).
  const src = process.cwd();
  if (await hasGitDir(src)) {
    instances.push({ id: SOURCE_FS_ID, label: "BrowserOS Source", vfsPath: "/", root: src });
  }

  return instances;
}

/** Look up a single GitFS instance by id. */
export async function getGitFsInstance(id: string): Promise<GitFsInstance | undefined> {
  return (await getAvailableGitFsInstances()).find((i) => i.id === id);
}
