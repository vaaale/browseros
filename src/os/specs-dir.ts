import "server-only";
import path from "path";
import { dataDir } from "./data-dir";

// Container directory for spec stores (018-external-spec-store). Each spec store
// is an independent git repo living in a SUBDIRECTORY of this root; the root
// itself is a plain container, never a git repo.
//
// 027 relocated the default from <cwd>/specs to <dataDir>/specs, so user specs
// live in the per-user data volume (survive a VFS wipe, isolated per user under
// the bastion) instead of the source clone. Still overridable via BOS_SPECS_ROOT
// — the Supervisor sets it to a preview's `<worktree>/specs` so specs stay
// branch-coupled to the code (020).
export function specsRoot(): string {
  const override = process.env.BOS_SPECS_ROOT;
  return override && override.trim() ? override.trim() : path.join(dataDir(), "specs");
}
