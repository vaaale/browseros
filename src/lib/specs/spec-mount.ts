import "server-only";
import path from "node:path";
import { specsRoot } from "@/os/specs-dir";
import { registerMount } from "@/os/vfs";
import { SpecFS } from "@/os/fs/spec-fs";
import { logger } from "@/lib/logging/server-logger";

// Wiring for the SpecFS mount (027-vfs-specfs). Idempotent: the first call
// registers `/Documents/Specs` → SpecFS(<specsRoot>/user-specs) and kicks the
// one-time crash-recovery sweep. The active feature branch is resolved per
// request from the feature scope (per-conversation model), so no global
// activation handler is needed — SpecFS materializes a branch's worktree lazily
// on first write.
//
// Rooting on specsRoot() (not a hardcoded data path) is what keeps previews
// branch-coupled: under the Supervisor, specsRoot() is `<worktree>/specs`, so the
// user store resolves to the preview's branch-coupled worktree (020).
//
// Invoked lazily from vfs.ensureVfs() via dynamic import so the low-level VFS
// never statically depends on the spec layer.

/** The store id (directory name) of the user spec store, used for the Supervisor
 *  worktree mount path (`<worktree>/specs/<id>`) and store discovery. */
export const USER_STORE_ID = "user-specs";
const COMPONENT = "specfs.mount";

export function userSpecRoot(): string {
  return path.join(specsRoot(), USER_STORE_ID);
}

let specFs: SpecFS | null = null;

export function ensureSpecMount(): SpecFS {
  if (specFs) return specFs;
  const root = userSpecRoot();
  const worktrees = path.join(specsRoot(), ".worktrees");
  const fsBackend = new SpecFS(root, USER_STORE_ID, worktrees);

  registerMount("/Documents/Specs", fsBackend);
  void fsBackend.runStartupSweep();
  specFs = fsBackend;
  logger().debug(COMPONENT, "SpecFS mounted at /Documents/Specs", { root, worktrees });
  return fsBackend;
}
