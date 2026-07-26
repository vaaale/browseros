import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import * as vfs from "@/os/vfs";
import type { GitAuth } from "./auth";
import { gitLock } from "./lock";
import { gitLogger } from "./logging";
import {
  runGitCommand,
  isMergeConflict,
  makeError,
  fetchRepo,
  isAncestor,
  fastForwardMerge,
  hasUncommittedChanges,
  stashChanges,
  popStash,
  createTag,
  resetHardAndClean,
  type GitError,
  type MergeStrategy,
} from "./git-ops";
import { startAssistantRun } from "@/lib/assistant/start-run";
import { runManager } from "@/lib/assistant/run-manager";

// Shared reconciliation pipeline (001-external-repo-integration, User Story
// 6): the SAME conflict-handling behavior for every GitFS instance — the BOS
// source repo (via the Supervisor's promote pipeline), spec stores, the
// installed-apps repo, and VFS-mounted repos. Supersedes the old synchronous
// "confirm: true before executing" model (AD-007): try increasingly capable
// automatic steps, and only fall back to a supervised, autonomous DevOps
// Agent when scripted reconciliation can't complete safely.
//
// Deliberately does NOT reuse mergeBranch()/rebaseOntoRemote() from
// git-ops.ts: those operate on a `<remote>/<branch>` remote-tracking ref,
// but this pipeline also needs to merge a purely LOCAL ref (a feature branch
// onto a local base branch, e.g. the Supervisor's promote step) onto HEAD —
// a strict generalization. The strategy-attempt/abort logic below mirrors
// mergeBranch's, parametrized over an arbitrary `sourceRef` instead.

const CHATS_DIR = "/Documents/Chats";
const DEVOPS_AGENT_ID = "devops";
const DEFAULT_MAX_ESCALATION_WAIT_MS = 25 * 60 * 1000; // 25 minutes

const OP = "gitops.reconcile";

export interface ReconcileOptions {
  /** Absolute path to the git working tree being reconciled. */
  repoPath: string;
  /** The remote to sync against before merging (e.g. "origin"). Omit for a
   *  purely local reconciliation (e.g. the Supervisor merging a feature
   *  branch onto base) — the remote-sync step (2) is skipped entirely. */
  remote?: string;
  /** The remote's branch name to sync against (e.g. "main"). Required iff
   *  `remote` is given. */
  branch?: string;
  /** What actually gets merged/rebased onto HEAD after the sync step — a
   *  remote-tracking ref (`${remote}/${branch}`, the common case) or an
   *  arbitrary local ref (e.g. a feature branch being promoted onto base). */
  sourceRef: string;
  strategy: MergeStrategy;
  auth?: GitAuth;
  /** Present only when reconciling BOS's own source inside an ACTIVE
   *  Supervisor-tracked feature-branch worktree — pre-set on the escalation
   *  conversation so `dev_delegate` can target it directly. Omit for any
   *  other GitFS instance (spec stores, apps repo, VFS mounts): the DevOps
   *  Agent will report that file-level delegation isn't available there. */
  featureBranchForDelegate?: string;
  /** Extra free-text context appended to the DevOps Agent's task. */
  escalationContext?: string;
  maxEscalationWaitMs?: number;
  /** Fires the moment escalation STARTS (conversation created, run kicked
   *  off) — before the potentially-long wait for it to finish. Lets a caller
   *  that itself blocks on `reconcile()` (e.g. a job wrapper polled by the
   *  Supervisor) surface "escalated, here's the conversation" immediately,
   *  rather than only once the whole call eventually returns. */
  onEscalate?: (conversationId: string) => void;
}

export interface ReconcileOutcome {
  status: "success" | "escalated" | "timed-out" | "failed";
  /** Which step actually resolved it: the configured strategy, "rebase-fallback",
   *  or "devops-agent" when escalated. Absent on "failed"/"timed-out". */
  method?: string;
  /** The rollback-anchor tag created before any merge/rebase was attempted —
   *  always present once step 1 has run, even on failure. */
  rollbackTag: string;
  /** Present when status is "escalated" or "timed-out". */
  devopsConversationId?: string;
  /** The DevOps Agent run's own terminal status, when escalated and it
   *  finished before the timeout ("completed" | "cancelled" | "error" | "max_steps"). */
  runStatus?: string;
  error?: { code: string; message: string; suggestion?: string };
}

// FR-022: reject a second concurrent reconciliation against a target that
// already has an in-progress escalation — re-point to the existing
// conversation instead of starting a parallel pipeline against the same repo.
const inFlightEscalations = new Map<string, string>(); // repoPath -> devopsConversationId

function tagStamp(): string {
  return new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
}

function newConversationId(): string {
  return `c-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Create a brand-new, normal, PERSISTED Assistant conversation scoped to the
 *  DevOps Agent — visible/discoverable in the Assistant app's conversation
 *  list from the moment it's created (US6 AS9), never ephemeral. Writing the
 *  file directly (rather than through startAssistantRun) lets us pre-set
 *  `activeFeatureBranch` before the run starts. */
async function createDevOpsConversation(featureBranch: string | undefined, title: string): Promise<string> {
  const id = newConversationId();
  await vfs.mkdir(CHATS_DIR).catch(() => undefined);
  await vfs.writeText(
    `${CHATS_DIR}/${id}.json`,
    JSON.stringify(
      {
        id,
        title,
        createdAt: Date.now(),
        agentId: DEVOPS_AGENT_ID,
        ...(featureBranch ? { activeFeatureBranch: featureBranch } : {}),
        messages: [],
      },
      null,
      2,
    ),
  );
  return id;
}

/** Race the run's own completion promise against a timeout. `run.done`
 *  resolves exactly when the agent loop exits (terminal, whatever the
 *  reason) — no polling needed since caller and run share this process. */
async function waitForRun(
  run: Awaited<ReturnType<typeof startAssistantRun>>,
  maxWaitMs: number,
): Promise<"finished" | "timed-out"> {
  if (!run.done) return "finished"; // no loop was ever attached — nothing to wait for
  let timer: NodeJS.Timeout;
  const timeout = new Promise<"timed-out">((resolve) => {
    timer = setTimeout(() => resolve("timed-out"), maxWaitMs);
  });
  const finished = run.done.then((): "finished" => "finished");
  const result = await Promise.race([finished, timeout]);
  clearTimeout(timer!);
  return result;
}

/** `git merge --squash <ref>` is a no-op (exit 0, nothing staged) when `ref`
 *  is already fully contained in HEAD — e.g. reconciling a branch that a
 *  fast-forward in step 2 already brought fully up to date. The subsequent
 *  `git commit` would fail ("nothing to commit") in that case, so callers
 *  must check this first and treat a clean no-op as success. */
async function hasStagedChanges(repoPath: string): Promise<boolean> {
  const { exitCode } = await runGitCommand(["diff", "--cached", "--quiet"], { cwd: repoPath });
  return exitCode !== 0; // `diff --quiet` exits 1 when there IS a diff
}

/** Attempt the configured merge strategy against `sourceRef`. Mirrors
 *  git-ops.ts's mergeBranch, generalized to an arbitrary ref and with its own
 *  full logging (every step, success or failure — not just failures). */
async function attemptStrategy(
  repoPath: string,
  sourceRef: string,
  strategy: MergeStrategy,
): Promise<{ status: "success" } | { status: "conflict" } | { status: "failed"; error: GitError }> {
  const op = `${OP}.strategy`;
  gitLogger().debug({ op, repoPath, remote: sourceRef });

  if (strategy === "commit") {
    await stashChanges(repoPath);
    try {
      const { stderr, exitCode } = await runGitCommand(["merge", "--squash", sourceRef], { cwd: repoPath });
      if (exitCode !== 0 && isMergeConflict(stderr)) {
        await resetHardAndClean(repoPath).catch(() => undefined);
        gitLogger().warn({ op, repoPath, remote: sourceRef, success: false, error: { code: "MERGE_CONFLICT", message: stderr } });
        return { status: "conflict" };
      }
      if (exitCode !== 0) {
        gitLogger().error({ op, repoPath, remote: sourceRef, success: false, error: { code: "GIT_MERGE_FAILED", message: stderr } });
        return { status: "failed", error: makeError("GIT_MERGE_FAILED", stderr) };
      }
      if (await hasStagedChanges(repoPath)) {
        const commit = await runGitCommand(["commit", "-m", `Merge ${sourceRef} (commit strategy)`], { cwd: repoPath });
        if (commit.exitCode !== 0) {
          gitLogger().error({ op, repoPath, remote: sourceRef, success: false, error: { code: "GIT_COMMIT_FAILED", message: commit.stderr } });
          return { status: "failed", error: makeError("GIT_COMMIT_FAILED", commit.stderr) };
        }
      }
    } finally {
      await popStash(repoPath);
    }
    gitLogger().info({ op, repoPath, remote: sourceRef, success: true, error: undefined });
    return { status: "success" };
  }

  const args = strategy === "merge-squash" ? ["merge", "--squash", sourceRef] : ["merge", sourceRef];
  const { stderr, exitCode } = await runGitCommand(args, { cwd: repoPath });
  if (exitCode !== 0 && isMergeConflict(stderr)) {
    if (strategy === "merge-squash") {
      await resetHardAndClean(repoPath).catch(() => undefined);
    } else {
      await runGitCommand(["merge", "--abort"], { cwd: repoPath }).catch(() => undefined);
    }
    gitLogger().warn({ op, repoPath, remote: sourceRef, success: false, error: { code: "MERGE_CONFLICT", message: stderr } });
    return { status: "conflict" };
  }
  if (exitCode !== 0) {
    gitLogger().error({ op, repoPath, remote: sourceRef, success: false, error: { code: "GIT_MERGE_FAILED", message: stderr } });
    return { status: "failed", error: makeError("GIT_MERGE_FAILED", stderr) };
  }
  // merge-squash leaves the merge staged but uncommitted by design — but is a
  // no-op (nothing staged) when sourceRef was already fully contained in
  // HEAD, in which case there's nothing to commit.
  if (strategy === "merge-squash" && (await hasStagedChanges(repoPath))) {
    const commit = await runGitCommand(["commit", "-m", `Squash-merge ${sourceRef}`], { cwd: repoPath });
    if (commit.exitCode !== 0) {
      gitLogger().error({ op, repoPath, remote: sourceRef, success: false, error: { code: "GIT_COMMIT_FAILED", message: commit.stderr } });
      return { status: "failed", error: makeError("GIT_COMMIT_FAILED", commit.stderr) };
    }
  }
  gitLogger().info({ op, repoPath, remote: sourceRef, success: true, error: undefined });
  return { status: "success" };
}

/** Scripted rebase-based fallback against `sourceRef` — replays HEAD's
 *  unique commits on top of it. Mirrors git-ops.ts's rebaseOntoRemote,
 *  generalized to an arbitrary ref. Always leaves the working tree clean on
 *  conflict (abort + defensive removal of rebase state dirs). */
async function attemptRebaseFallback(
  repoPath: string,
  sourceRef: string,
): Promise<{ status: "success" } | { status: "conflict" } | { status: "failed"; error: GitError }> {
  const op = `${OP}.rebase-fallback`;
  gitLogger().debug({ op, repoPath, remote: sourceRef });

  const dirty = await hasUncommittedChanges(repoPath);
  if (dirty) await stashChanges(repoPath);
  try {
    const { stdout, stderr, exitCode } = await runGitCommand(["rebase", sourceRef], { cwd: repoPath });
    if (exitCode !== 0) {
      await runGitCommand(["rebase", "--abort"], { cwd: repoPath }).catch(() => undefined);
      await fs.rm(path.join(repoPath, ".git", "rebase-merge"), { recursive: true, force: true }).catch(() => undefined);
      await fs.rm(path.join(repoPath, ".git", "rebase-apply"), { recursive: true, force: true }).catch(() => undefined);
      if (isMergeConflict(stderr) || isMergeConflict(stdout)) {
        gitLogger().warn({ op, repoPath, remote: sourceRef, success: false, error: { code: "REBASE_CONFLICT", message: stderr || stdout } });
        return { status: "conflict" };
      }
      gitLogger().error({ op, repoPath, remote: sourceRef, success: false, error: { code: "GIT_REBASE_FAILED", message: stderr || stdout } });
      return { status: "failed", error: makeError("GIT_REBASE_FAILED", stderr || stdout) };
    }
    gitLogger().info({ op, repoPath, remote: sourceRef, success: true, error: undefined });
    return { status: "success" };
  } finally {
    if (dirty) await popStash(repoPath);
  }
}

/**
 * Run the shared reconciliation pipeline: rollback tag → sync `branch` with
 * `remote` → attempt `strategy` against `sourceRef` → on conflict, abort
 * cleanly and attempt a scripted rebase fallback → on conflict again, abort
 * cleanly and escalate to the DevOps Agent (blocking until it reaches a
 * terminal state or the timeout elapses). Every step is logged, success or
 * failure — this is the audit trail for the whole workflow, not just the
 * final outcome.
 */
export async function reconcile(opts: ReconcileOptions): Promise<ReconcileOutcome> {
  const { repoPath, remote, branch, sourceRef, strategy, auth } = opts;
  const maxEscalationWaitMs = opts.maxEscalationWaitMs ?? DEFAULT_MAX_ESCALATION_WAIT_MS;

  gitLogger().info({ op: OP, repoPath, remote, success: true, error: undefined });

  const existingEscalation = inFlightEscalations.get(repoPath);
  if (existingEscalation) {
    gitLogger().info({ op: `${OP}.already-escalated`, repoPath, remote, success: true, error: undefined });
    return { status: "escalated", rollbackTag: "", devopsConversationId: existingEscalation };
  }

  const release = await gitLock().acquire(repoPath, OP);
  let lockReleased = false;
  const releaseLock = async (): Promise<void> => {
    if (lockReleased) return;
    lockReleased = true;
    await release();
  };

  const rollbackTag = `bos/pre-reconcile-${tagStamp()}`;

  try {
    // Step 1: rollback tag — always first, so the pre-reconciliation state is
    // recoverable no matter how the rest of the pipeline goes.
    await createTag(repoPath, rollbackTag, `Pre-reconciliation snapshot before merging ${sourceRef}${branch ? ` onto ${branch}` : ""}`);

    // Step 2: sync the local branch with the remote FIRST (if one was given)
    // — reduces the odds of a conflict a plain fast-forward would have
    // avoided entirely. Skipped for a purely local reconciliation (e.g. the
    // Supervisor merging a feature branch onto an already-synced base).
    if (remote && branch) {
      await fetchRepo(repoPath, remote, branch, auth);
      if (await isAncestor(repoPath, "HEAD", `${remote}/${branch}`)) {
        await fastForwardMerge(repoPath, remote, branch);
        gitLogger().info({ op: `${OP}.sync`, repoPath, remote, success: true, error: undefined });
      } else {
        gitLogger().debug({ op: `${OP}.sync`, repoPath, remote, success: true, error: undefined });
      }
    } else {
      gitLogger().debug({ op: `${OP}.sync`, repoPath, remote, success: true, error: undefined });
    }

    // Step 3: the configured strategy.
    const strategyResult = await attemptStrategy(repoPath, sourceRef, strategy);
    if (strategyResult.status === "success") {
      gitLogger().info({ op: OP, repoPath, remote, success: true, error: undefined });
      await releaseLock();
      return { status: "success", method: strategy, rollbackTag };
    }
    if (strategyResult.status === "failed") {
      gitLogger().error({ op: OP, repoPath, remote, success: false, error: strategyResult.error });
      await releaseLock();
      return { status: "failed", rollbackTag, error: strategyResult.error };
    }

    // Step 4: scripted rebase-based fallback.
    const rebaseResult = await attemptRebaseFallback(repoPath, sourceRef);
    if (rebaseResult.status === "success") {
      gitLogger().info({ op: OP, repoPath, remote, success: true, error: undefined });
      await releaseLock();
      return { status: "success", method: "rebase-fallback", rollbackTag };
    }
    if (rebaseResult.status === "failed") {
      gitLogger().error({ op: OP, repoPath, remote, success: false, error: rebaseResult.error });
      await releaseLock();
      return { status: "failed", rollbackTag, error: rebaseResult.error };
    }

    // Step 5: escalate to the DevOps Agent.
    gitLogger().warn({
      op: `${OP}.escalate`,
      repoPath,
      remote,
      success: false,
      error: { code: "RECONCILE_UNRESOLVED", message: `configured strategy (${strategy}) and the scripted rebase fallback both conflicted` },
    });

    const task = [
      "Reconcile a git conflict that automated steps couldn't resolve.",
      `repoPath: ${repoPath}`,
      remote && branch ? `remote: ${remote} (synced against ${remote}/${branch} first)` : "remote: none (purely local reconciliation)",
      `sourceRef being merged: ${sourceRef}`,
      `rollback tag (if you need to see the pre-reconciliation state): ${rollbackTag}`,
      `configured strategy tried: ${strategy} — conflicted`,
      "scripted rebase fallback also tried — conflicted",
      opts.featureBranchForDelegate
        ? `This IS the Supervisor-tracked feature branch "${opts.featureBranchForDelegate}" — dev_delegate targets its existing preview worktree directly.`
        : "This is NOT a Supervisor-tracked BOS-source feature branch — dev_delegate may not apply here; if so, report that manual resolution is needed instead.",
      opts.escalationContext ? `Additional context: ${opts.escalationContext}` : "",
    ].filter(Boolean).join("\n");

    const conversationId = await createDevOpsConversation(
      opts.featureBranchForDelegate,
      `Resolve conflict: ${sourceRef}${branch ? ` → ${remote}/${branch}` : ""}`,
    );
    inFlightEscalations.set(repoPath, conversationId);
    gitLogger().info({ op: `${OP}.escalate`, repoPath, remote, success: true, error: undefined });
    opts.onEscalate?.(conversationId);

    let run: Awaited<ReturnType<typeof startAssistantRun>>;
    try {
      run = await startAssistantRun({ conversationId, agentId: DEVOPS_AGENT_ID, message: task });
    } finally {
      // Release BEFORE the (potentially long) wait — the escalation's own git
      // work happens through the Developer's worktree, not through this
      // pipeline's lock hold, and the lock's own auto-release is 30s anyway.
      await releaseLock();
    }

    const waitResult = await waitForRun(run, maxEscalationWaitMs);
    if (waitResult === "timed-out") {
      gitLogger().warn({
        op: `${OP}.escalate.timeout`,
        repoPath,
        remote,
        success: false,
        error: { code: "ESCALATION_TIMED_OUT", message: `DevOps Agent run ${run.id} did not finish within ${maxEscalationWaitMs}ms` },
      });
      return { status: "timed-out", rollbackTag, devopsConversationId: conversationId };
    }

    inFlightEscalations.delete(repoPath);
    const finished = runManager().get(run.id);
    gitLogger().info({
      op: `${OP}.escalate.finished`,
      repoPath,
      remote,
      success: true,
      error: finished?.error ? { code: "DEVOPS_RUN_ERROR", message: finished.error } : undefined,
    });
    return {
      status: "escalated",
      method: "devops-agent",
      rollbackTag,
      devopsConversationId: conversationId,
      runStatus: finished?.status,
    };
  } catch (e) {
    const gitErr = e as GitError;
    const error = { code: gitErr.code ?? "RECONCILE_FAILED", message: gitErr.message ?? String(e), suggestion: gitErr.suggestion };
    gitLogger().error({ op: OP, repoPath, remote, success: false, error });
    return { status: "failed", rollbackTag, error };
  } finally {
    await releaseLock();
  }
}
