import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { logger } from "@/lib/logging/server-logger";
import { supervisorEnabled, supervisorBeginOrThrow } from "./supervisor";

const COMPONENT = "devharness.branch-data-root";

// Where a WRITE that belongs to a feature branch must land.
//
// `dataDir()` is a per-process constant by design (src/os/data-dir.ts): each
// running version — base and every preview — has its own fixed data root. A
// preview's root IS its branch's data clone, so anything written there already
// belongs to that branch. BASE's root is the live, canonical one, so a write
// that belongs to a feature branch must be redirected into that branch's clone
// instead — the same clone the Supervisor mounts the branch-coupled `user-apps`
// worktree into (coupled-repos.mjs's coupledReposFor).
//
// This exists so the user can stay on BASE for the whole of a piece of work —
// authoring specs AND building apps — and only switch to the preview at the end
// to test the built candidate. Without it, item CONTENT writes (installItem)
// and item SPEC writes (dev/spec-fs.ts) would disagree about where a feature
// branch's work goes, purely because one of them happened to be written against
// `dataDir()` and the other against a resolved root.

/**
 * The data root that writes for `branch` must target.
 *
 * - No branch: this process's own root (an unbranded, live write).
 * - Under the Supervisor: THAT branch's data clone, resolved by asking the
 *   Supervisor. This is deliberately not special-cased for previews. A preview
 *   asking for its OWN branch gets back its own root (the Supervisor hands out
 *   the same absolute path it launched the preview with), so the common case is
 *   unchanged — but a preview asking for a DIFFERENT branch gets that branch's
 *   clone, which is the correct answer and the reason the short-circuit that
 *   used to live here was removed. The pin (which preview you are viewing) and
 *   the conversation's active feature branch are independent: you can be on
 *   bos/A's preview with bos/B active, and short-circuiting on
 *   BOS_VERSION_LABEL alone silently committed bos/B's work onto bos/A.
 *
 * Throws rather than silently returning the live root when a branch was asked
 * for but cannot be resolved: quietly writing a branch's work into the live
 * directory is the exact failure this indirection exists to prevent.
 */
export async function branchDataRoot(branch?: string): Promise<string> {
  if (!branch) return dataDir();
  if (!supervisorEnabled()) {
    // Standalone dev: there is no clone to redirect into, so the branch is
    // recorded by the git checkout itself rather than by path. This is the same
    // rule dev/spec-fs.ts follows — the branch REQUIREMENT is unconditional,
    // only the ROUTING depends on the Supervisor.
    return dataDir();
  }
  const { dataDir: clone } = await supervisorBeginOrThrow(branch);
  if (!clone) {
    throw new Error(`Supervisor returned no data clone for branch "${branch}"; refusing to write its content to the live data directory.`);
  }
  try {
    await fs.access(path.join(clone, "user-apps"));
  } catch (err) {
    logger().warn(COMPONENT, "user-apps mount missing in branch data clone", { branch, clone, err: String(err) });
    throw new Error(
      `user-apps is not mounted for branch "${branch}" (${(err as NodeJS.ErrnoException)?.code ?? "unknown"}); its content cannot be written there yet.`,
    );
  }
  logger().debug(COMPONENT, "resolved branch data root", { branch, clone });
  return clone;
}
