import "server-only";
import path from "node:path";
import { git, defaultBranch, ensureWorktree, pruneWorktree, localBranches } from "@/os/fs/git-fs";
import { encodeBranchDir } from "@/lib/specs/feature-id";
import { ensureSpecMount, userSpecRoot } from "@/lib/specs/spec-mount";
import { dataDir } from "@/os/data-dir";
import { logger } from "@/lib/logging/server-logger";
import { reconcile } from "@/lib/gitops/reconcile";

// Promotion for a user-spec feature (027-vfs-specfs). FRAGILE: git merges +
// worktree pruning. The invariant is that `main` only ever fast-forwards — the
// feature branch is reconciled against `main` FIRST (in its worktree), so a
// conflict surfaces as a first-class result on the branch and `main` is never
// left in a conflicted state. Whether the feature also touched BOS source is
// derived from git (a same-named branch in the source repo), not a tracked list.
//
// 035-spec-promote-conflict-escalation (FR-012): a conflict here no longer
// dead-ends with a static `{ kind: "conflict" }` and no agent. It routes
// through the shared reconciliation pipeline with the **user-specs** working
// context, which creates a resolution session, launches the configured
// conflict agent against THAT worktree (not the BOS source tree), and
// auto-launches the Build Studio conflict pane.

const COMPONENT = "specfs.promote";

export type PromoteResult =
  | { kind: "spec-only" }
  | { kind: "source-included"; branchName: string }
  /** The pipeline escalated: a resolution session is live and the operation
   *  completes when the session resolves. Non-terminal — the caller links
   *  into the session rather than reporting a failure (FR-018/FR-020). */
  | { kind: "escalated"; sessionId: string; conversationId?: string; rollbackTag: string; files: string[] }
  /** Terminal: the resolution genuinely did not complete. The rollback tag
   *  restores the pre-reconciliation state. */
  | { kind: "conflict"; files: string[]; sessionId?: string; rollbackTag?: string; message?: string };

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
    logger().warn(COMPONENT, "promote conflict — escalating, main untouched", { branch, files });

    // The pipeline owns everything from here: rollback tag, retry, rebase
    // fallback, and — when those don't land it — the session + agent + pane.
    // Completing the session is what finishes THIS promote (the ff of main
    // and the worktree prune below are handed to it as the completion plan).
    const outcome = await reconcile({
      repoPath: wtPath,
      sourceRef: base,
      strategy: "merge",
      repoKind: "user-specs",
      repoRoot,
      repoLabel: "user-specs store",
      mode: "working-tree",
      operationLabel: "spec promote",
      escalationContext: `Build Studio promote: reconciling user-specs branch "${branch}" against "${base}" in its worktree, so ${base} only ever fast-forwards.`,
      completion: {
        kind: "merge",
        strategy: "merge",
        ff: { repoRoot, baseBranch: base, ffBranch: branch },
        pruneWorktree: { repoRoot, worktreePath: wtPath },
      },
    });

    if (outcome.status === "success") {
      // A later pipeline step resolved it without ever escalating — fall
      // through to the normal completion below.
      logger().info(COMPONENT, "promote conflict resolved by the pipeline", { branch, method: outcome.method });
    } else if (outcome.status === "escalated") {
      return {
        kind: "escalated",
        sessionId: outcome.sessionId ?? "",
        conversationId: outcome.devopsConversationId,
        rollbackTag: outcome.rollbackTag,
        files,
      };
    } else {
      return {
        kind: "conflict",
        files,
        sessionId: outcome.sessionId,
        rollbackTag: outcome.rollbackTag,
        message: outcome.error?.message,
      };
    }
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
