import "server-only";
import path from "node:path";
import { dataDir } from "@/os/data-dir";
import { registerMount } from "@/os/vfs";
import { SpecFS } from "@/os/fs/spec-fs";
import { logger } from "@/lib/logging/server-logger";

// Wiring for the SpecFS mount (027-vfs-specfs). Idempotent: the first call
// registers `/Documents/Specs` → SpecFS(data/specs/user) and kicks the one-time
// crash-recovery sweep. The active feature branch is resolved per request from
// the feature scope (per-conversation model), so no global activation handler is
// needed — SpecFS materializes a branch's worktree lazily on first write.
//
// Invoked lazily from vfs.ensureVfs() via dynamic import so the low-level VFS
// never statically depends on the spec layer.

/** The store id (directory name) of the user spec store, used for the Supervisor
 *  worktree mount path (`<worktree>/specs/<id>`) and store discovery. */
export const USER_STORE_ID = "user";
const COMPONENT = "specfs.mount";

export function userSpecRoot(): string {
  return path.join(dataDir(), "specs", USER_STORE_ID);
}

let specFs: SpecFS | null = null;

export function ensureSpecMount(): SpecFS {
  if (specFs) return specFs;
  const root = userSpecRoot();
  const worktrees = path.join(dataDir(), "specs", ".worktrees");
  const fsBackend = new SpecFS(root, USER_STORE_ID, worktrees);

  registerMount("/Documents/Specs", fsBackend);
  void fsBackend.runStartupSweep();
  specFs = fsBackend;
  logger().debug(COMPONENT, "SpecFS mounted at /Documents/Specs", { root, worktrees });
  return fsBackend;
}
