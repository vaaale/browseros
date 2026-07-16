import "server-only";
import path from "node:path";
import { git, defaultBranch, ensureWorktree, pruneWorktree, localBranches } from "@/os/fs/git-fs";
import { encodeBranchDir } from "@/lib/specs/feature-id";
import { ensureSpecMount, userSpecRoot } from "@/lib/specs/spec-mount";
import { dataDir } from "@/os/data-dir";
import { logger } from "@/lib/logging/server-logger";

// Promotion for a user-spec feature (027-vfs-specfs). FRAGILE: git merges +
// worktree pruning. The invariant is that `main` only ever fast-forwards — the
// feature branch is reconciled against `main` FIRST (in its worktree), so a
// conflict surfaces as a first-class result on the branch and `main` is never
// left in a conflicted state. Whether the feature also touched BOS source is
// derived from git (a same-named branch in the source repo), not a tracked list.

const COMPONENT = "specfs.promote";

export type PromoteResult =
  | { kind: "spec-only" }
  | { kind: "source-included"; branchName: string }
  | { kind: "conflict"; files: string[] };

/** Promote a feature's user-spec changes on `branch` into `main`. */
export async function promoteFeature(branch: string): Promise<PromoteResult> {
  if (!branch || !branch.trim()) throw new Error("promoteFeature requires a feature branch");
  const repoRoot = userSpecRoot();
  const wtPath = path.join(dataDir(), "specs", ".worktrees", encodeBranchDir(branch));

  logger().debug(COMPONENT, "promote start", { branch });

  // 1. Force any debounced writes to commit before reading committed state.
  const specFs = ensureSpecMount();
  await specFs.flushPending(branch);

  // 2. Reconcile main INTO the feature branch inside its worktree so main stays
  //    linear. Provision the worktree if it isn't materialized.
  await ensureWorktree(repoRoot, wtPath, branch);
  const base = await defaultBranch(repoRoot);

  try {
    await git(wtPath, ["merge", "--no-edit", base]);
  } catch {
    const conflicted = await git(wtPath, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "");
    const files = conflicted.split("\n").map((s) => s.trim()).filter(Boolean);
    await git(wtPath, ["merge", "--abort"]).catch(() => {});
    logger().warn(COMPONENT, "promote conflict — main untouched", { branch, files });
    return { kind: "conflict", files };
  }

  // 3. Fast-forward main to the reconciled branch (base checkout, on `base`).
  await git(repoRoot, ["merge", "--ff-only", branch]);

  // 4. Prune the worktree.
  await pruneWorktree(repoRoot, wtPath);

  // 5. Spec-only vs source-included: a same-named branch in the BOS source repo
  //    means the Developer agent also worked on code — surface it for PR review.
  const sourceBranches = await localBranches(process.cwd()).catch(() => [] as string[]);
  const kind = sourceBranches.includes(branch) ? "source-included" : "spec-only";
  logger().info(COMPONENT, "promote done", { branch, kind });
  return kind === "spec-only" ? { kind } : { kind, branchName: branch };
}
