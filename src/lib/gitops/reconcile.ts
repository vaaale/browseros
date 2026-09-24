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
  gitIdentityEnv,
  resetHardAndClean,
  type GitError,
  type MergeStrategy,
} from "./git-ops";
import { startAssistantRun } from "@/lib/assistant/start-run";
import { runManager } from "@/lib/assistant/run-manager";
import { patchConversation } from "@/lib/agent/conversations-server";
import { conflictAgentId } from "./conflict-agent";
import {
  captureSnapshot,
  createSession,
  emitEscalatedEvent,
  failSession,
  findActiveSessionForRepo,
  getSession,
  setSessionRun,
  timeoutSession,
  completeSession,
} from "./sessions/store";
import { isTerminalStatus, type ConflictSession, type RepoKind, type SessionCompletion, type WorkContext, type WorkMode } from "./sessions/types";

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
const DEFAULT_MAX_ESCALATION_WAIT_MS = 25 * 60 * 1000; // 25 minutes
// How often the escalation re-checks its session. The session store is
// in-process, so this is a Map read plus (at most) one small file read.
const SESSION_POLL_MS = 1_500;

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
   *  rather than only once the whole call eventually returns.
   *  035: also carries the resolution session id (FR-018). */
  onEscalate?: (conversationId: string, sessionId: string) => void;

  // ── 035-spec-promote-conflict-escalation ──────────────────────────────────
  // The escalation's WORKING CONTEXT is a parameter, configured per repo at
  // execution time (FR-003/FR-004). The access mechanism never varies — only
  // these fields do. Every one has a sane default derived from `repoPath`, so
  // an existing caller that passes none behaves exactly as before (FR-023).

  /** Which managed repo this is — labelling + the `dev_delegate` note only. */
  repoKind?: RepoKind;
  /** The repo root, when `repoPath` is a linked worktree. Defaults to repoPath. */
  repoRoot?: string;
  /** Human label shown in the conflict pane's status header. */
  repoLabel?: string;
  /** `plumbing` when there is no live checkout to write into (the
   *  Supervisor's busy-checkout path). Defaults to `working-tree`. */
  mode?: WorkMode;
  /** What finishing the resolution must DO to complete the underlying
   *  operation. Defaults to "redo the merge here and commit". */
  completion?: Partial<SessionCompletion>;
  /** Short description of the operation that hit the conflict ("promote",
   *  "pull", …) — rendered in the pane. */
  operationLabel?: string;
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
  /** 035 (FR-018): the resolution session the caller can link into. Present
   *  whenever an escalation happened, so every surface — the Supervisor's
   *  promote response, the git-remotes fetch/push responses, Build Studio —
   *  can open the conflict pane for it. */
  sessionId?: string;
  /** The session's terminal (or parked) status, so a caller can distinguish
   *  `awaiting-user` (non-terminal, parked for the user) from a real terminal
   *  outcome (FR-020). */
  sessionStatus?: string;
  /** The DevOps Agent run's own terminal status, when escalated and it
   *  finished before the timeout ("completed" | "cancelled" | "error" | "max_steps"). */
  runStatus?: string;
  error?: { code: string; message: string; suggestion?: string };
  /** Best-effort cleanup steps (abort/reset/stray-state removal) that failed
   *  along the way — the pipeline still reached a real outcome above, but
   *  these are recorded rather than silently dropped, since a caller (e.g.
   *  the Supervisor's promote) may want to surface them alongside a
   *  successful result instead of a false all-clear. */
  warnings?: string[];
}

// FR-022: reject a second concurrent reconciliation against a target that
// already has an in-progress escalation — re-point to the existing
// conversation instead of starting a parallel pipeline against the same repo.
//
// 035 (design S3): the value carries the session id too, and "in flight" now
// includes a session PARKED in `awaiting-user` — which can last indefinitely
// (D3). A second reconcile on the same repo re-points to that session; it must
// never re-escalate it or start a parallel pipeline (S12).
interface InFlightEscalation {
  conversationId: string;
  sessionId: string;
}
const inFlightEscalations = new Map<string, InFlightEscalation>(); // repoPath -> escalation

function tagStamp(): string {
  return new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
}

function newConversationId(): string {
  return `c-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Create a brand-new, normal, PERSISTED Assistant conversation scoped to the
 *  conflict-resolution agent — visible/discoverable in the Assistant app's
 *  conversation list from the moment it's created (US6 AS9), never ephemeral.
 *  Writing the file directly (rather than through startAssistantRun) lets us
 *  pre-set `activeFeatureBranch` before the run starts. */
async function createDevOpsConversation(
  agentId: string,
  featureBranch: string | undefined,
  title: string,
): Promise<string> {
  const id = newConversationId();
  await vfs.mkdir(CHATS_DIR).catch(() => undefined);
  await vfs.writeText(
    `${CHATS_DIR}/${id}.json`,
    JSON.stringify(
      {
        id,
        title,
        createdAt: Date.now(),
        agentId,
        ...(featureBranch ? { activeFeatureBranch: featureBranch } : {}),
        messages: [],
      },
      null,
      2,
    ),
  );
  return id;
}

/** Tag the conversation with the session id, as a top-level field alongside
 *  `activeFeatureBranch`. That is how each `conflict_*` tool finds its session
 *  from nothing but `ctx.conversationId` (design §7.2) — and it survives the
 *  park→rewake boundary, because `saveConversationMessages` preserves
 *  top-level fields when the loop rewrites the transcript. */
async function tagConversationWithSession(conversationId: string, sessionId: string): Promise<void> {
  try {
    await patchConversation(conversationId, { conflictSessionId: sessionId });
  } catch (e) {
    // Without the tag the agent's tools cannot find their session at all —
    // this is a hard failure, not a cosmetic one.
    throw makeError("CONVERSATION_TAG_FAILED", `could not tag conversation ${conversationId} with the conflict session: ${(e as Error).message}`);
  }
}

/** Build the per-repo working context (design §7.1). This is the ONLY thing
 *  that varies per repo: `conflict_read`/`conflict_write` treat every kind
 *  identically, operating on `repoPath` through the same git/file ops. */
async function buildWorkContext(opts: ReconcileOptions, oursRef: string, baseSha: string): Promise<WorkContext> {
  return {
    repoKind: opts.repoKind ?? (opts.featureBranchForDelegate ? "source" : "generic"),
    repoPath: opts.repoPath,
    repoRoot: opts.repoRoot ?? opts.repoPath,
    baseRef: baseSha,
    oursRef,
    theirsRef: opts.sourceRef,
    mode: opts.mode ?? "working-tree",
    label: opts.repoLabel ?? defaultRepoLabel(opts),
    ...(opts.featureBranchForDelegate ? { featureBranchForDelegate: opts.featureBranchForDelegate } : {}),
  };
}

function defaultRepoLabel(opts: ReconcileOptions): string {
  switch (opts.repoKind) {
    case "source":
      return "BOS source";
    case "user-specs":
      return "user-specs store";
    case "user-apps":
      return "user-apps";
    case "vfs-mount":
      return "VFS mount";
    default:
      return opts.featureBranchForDelegate ? "BOS source" : opts.repoPath;
  }
}

/** The name of the branch checked out at `repoPath` (the "ours" side), or the
 *  raw sha when HEAD is detached. */
async function currentOursRef(repoPath: string): Promise<string> {
  const symbolic = await runGitCommand(["symbolic-ref", "--short", "HEAD"], { cwd: repoPath });
  if (symbolic.exitCode === 0 && symbolic.stdout.trim()) return symbolic.stdout.trim();
  const sha = await runGitCommand(["rev-parse", "HEAD"], { cwd: repoPath });
  return sha.stdout.trim() || "HEAD";
}

/** A cleanup step (merge --abort, reset --hard, stray rebase-state removal)
 *  that's allowed to fail without aborting the pipeline — but the failure
 *  must be recorded, not silently swallowed by a bare `.catch(() => undefined)`.
 *  Every call site below pushes into a shared `warnings` array that flows
 *  all the way to `ReconcileOutcome.warnings`. */
async function bestEffort(label: string, repoPath: string, fn: () => Promise<unknown>, warnings: string[]): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const msg = `${label} failed: ${e instanceof Error ? e.message : String(e)}`;
    gitLogger().warn({ op: `${OP}.cleanup`, repoPath, error: { code: "CLEANUP_FAILED", message: msg } });
    warnings.push(msg);
  }
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
  warnings: string[],
): Promise<{ status: "success" } | { status: "conflict" } | { status: "failed"; error: GitError }> {
  const op = `${OP}.strategy`;
  gitLogger().debug({ op, repoPath, remote: sourceRef });
  // Managed repos BOS created have no git identity of their own; without this
  // every merge/commit below dies with "Committer identity unknown".
  const env = await gitIdentityEnv(repoPath);

  if (strategy === "commit") {
    await stashChanges(repoPath);
    try {
      const { stdout, stderr, exitCode } = await runGitCommand(["merge", "--squash", sourceRef], { cwd: repoPath, env });
      // git reports "CONFLICT (…)"/"Automatic merge failed" on STDOUT, not
      // stderr. Checking only stderr misclassified every plain merge conflict
      // as a hard GIT_MERGE_FAILED — which returns `failed` and never
      // escalates, defeating the whole no-dead-ends invariant (FR-016). The
      // rebase fallback below already checked both; this now matches it.
      if (exitCode !== 0 && (isMergeConflict(stderr) || isMergeConflict(stdout))) {
        await bestEffort("reset/clean after squash-merge conflict", repoPath, () => resetHardAndClean(repoPath), warnings);
        gitLogger().warn({ op, repoPath, remote: sourceRef, success: false, error: { code: "MERGE_CONFLICT", message: stderr } });
        return { status: "conflict" };
      }
      if (exitCode !== 0) {
        gitLogger().error({ op, repoPath, remote: sourceRef, success: false, error: { code: "GIT_MERGE_FAILED", message: stderr || stdout } });
        return { status: "failed", error: makeError("GIT_MERGE_FAILED", stderr || stdout) };
      }
      if (await hasStagedChanges(repoPath)) {
        const commit = await runGitCommand(["commit", "-m", `Merge ${sourceRef} (commit strategy)`], { cwd: repoPath, env });
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
  const { stdout, stderr, exitCode } = await runGitCommand(args, { cwd: repoPath, env });
  if (exitCode !== 0 && (isMergeConflict(stderr) || isMergeConflict(stdout))) {
    if (strategy === "merge-squash") {
      await bestEffort("reset/clean after squash-merge conflict", repoPath, () => resetHardAndClean(repoPath), warnings);
    } else {
      await bestEffort("merge --abort after conflict", repoPath, () => runGitCommand(["merge", "--abort"], { cwd: repoPath }), warnings);
    }
    gitLogger().warn({ op, repoPath, remote: sourceRef, success: false, error: { code: "MERGE_CONFLICT", message: stderr } });
    return { status: "conflict" };
  }
  if (exitCode !== 0) {
    gitLogger().error({ op, repoPath, remote: sourceRef, success: false, error: { code: "GIT_MERGE_FAILED", message: stderr || stdout } });
    return { status: "failed", error: makeError("GIT_MERGE_FAILED", stderr || stdout) };
  }
  // merge-squash leaves the merge staged but uncommitted by design — but is a
  // no-op (nothing staged) when sourceRef was already fully contained in
  // HEAD, in which case there's nothing to commit.
  if (strategy === "merge-squash" && (await hasStagedChanges(repoPath))) {
    const commit = await runGitCommand(["commit", "-m", `Squash-merge ${sourceRef}`], { cwd: repoPath, env });
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
  warnings: string[],
): Promise<{ status: "success" } | { status: "conflict" } | { status: "failed"; error: GitError }> {
  const op = `${OP}.rebase-fallback`;
  gitLogger().debug({ op, repoPath, remote: sourceRef });

  // hasUncommittedChanges throws on a failed status read (rather than
  // silently reporting "clean") — that throw is intentionally left
  // uncaught here, propagating to reconcile()'s outer try/catch as a
  // genuine "failed" outcome, since proceeding as if the tree were clean
  // could stash-skip real uncommitted work right before a rebase.
  const dirty = await hasUncommittedChanges(repoPath);
  if (dirty) await stashChanges(repoPath);
  try {
    const { stdout, stderr, exitCode } = await runGitCommand(["rebase", sourceRef], { cwd: repoPath, env: await gitIdentityEnv(repoPath) });
    if (exitCode !== 0) {
      await bestEffort("rebase --abort", repoPath, () => runGitCommand(["rebase", "--abort"], { cwd: repoPath }), warnings);
      // Defensive belt-and-braces: `rebase --abort` can itself fail to fully
      // clean up (e.g. a corrupted rebase state) — remove the state dirs
      // directly so a stuck rebase never blocks the next operation.
      await bestEffort("remove stray rebase-merge state", repoPath, () => fs.rm(path.join(repoPath, ".git", "rebase-merge"), { recursive: true, force: true }), warnings);
      await bestEffort("remove stray rebase-apply state", repoPath, () => fs.rm(path.join(repoPath, ".git", "rebase-apply"), { recursive: true, force: true }), warnings);
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

/** Re-hydrate the in-flight guard from the durable store, so a session that
 *  outlived the process (or has been parked in `awaiting-user` since long
 *  before this call) still blocks a parallel pipeline (S12, design S3). */
async function activeEscalationFor(repoPath: string): Promise<InFlightEscalation | undefined> {
  const active = await findActiveSessionForRepo(repoPath).catch(() => undefined);
  if (!active) return undefined;
  const entry = { conversationId: active.conversationId, sessionId: active.id };
  inFlightEscalations.set(repoPath, entry);
  return entry;
}

/** The escalation task. It names the session and the tools, because the whole
 *  agent↔user loop hangs off the agent actually calling them: `conflict_read`
 *  to see the three sides, `conflict_write` to resolve, `conflict_decision`
 *  when it genuinely cannot decide (which ENDS its turn — park-and-rewake),
 *  and `conflict_complete` when everything is resolved. */
function buildEscalationTask(args: {
  opts: ReconcileOptions;
  session: ConflictSession;
  rollbackTag: string;
  strategy: MergeStrategy;
  mergeTreeOutput: string;
}): string {
  const { opts, session, rollbackTag, strategy, mergeTreeOutput } = args;
  const { remote, branch, sourceRef, repoPath } = opts;
  const files = session.snapshot.files;
  return [
    "Reconcile a git conflict that automated steps couldn't resolve.",
    "",
    `Resolution session: ${session.id} (repo kind: ${session.workContext.repoKind}, mode: ${session.workContext.mode})`,
    `repo_path (pass this to every conflict_* tool): ${repoPath}`,
    remote && branch ? `remote: ${remote} (synced against ${remote}/${branch} first)` : "remote: none (purely local reconciliation)",
    `sourceRef being merged: ${sourceRef}`,
    `three-way refs — base: ${session.snapshot.base || "(none)"} · ours: ${session.snapshot.ours} · theirs: ${session.snapshot.theirs}`,
    `rollback tag (the pre-reconciliation state): ${rollbackTag}`,
    `configured strategy tried: ${strategy} — conflicted`,
    "scripted rebase fallback also tried — conflicted",
    "",
    files.length ? `Conflicting files (${files.length}):\n${files.map((f) => `  - ${f}`).join("\n")}` : "Conflicting files: (none detected — investigate with conflict_status)",
    "",
    "How to work this:",
    `1. \`conflict_read\` each file to see the ours/base/theirs content and the marker hunks.`,
    `2. Resolve autonomously whatever is unambiguous, writing the merged content with \`conflict_write\`. This is the default — do NOT ask the user about anything you can reasonably decide yourself.`,
    `3. Only for a GENUINELY ambiguous conflict, call \`conflict_decision\` with a specific question and (where you have one) a suggested merge. That tool PARKS the session: it returns \`parked: true\`, and you must then END YOUR TURN. You will be resumed with the user's answer in a new turn on this same conversation — the transcript is continuous, so you keep all your context.`,
    `4. A BINARY file cannot be merged as text: never write one. Surface it with \`conflict_decision\` (or \`conflict_abandon\`) naming the file and the rollback tag.`,
    `5. When every file is resolved, call \`conflict_complete\`. That is what actually completes the underlying operation (${session.operationLabel}). If you cannot resolve it at all, call \`conflict_abandon\` with the reason — do NOT report success you did not achieve.`,
    "",
    opts.featureBranchForDelegate
      ? `This IS the Supervisor-tracked feature branch "${opts.featureBranchForDelegate}" — dev_delegate targets its existing preview worktree directly, and remains available if a resolution needs real code work rather than a hunk merge.`
      : "This is NOT a Supervisor-tracked BOS-source feature branch — dev_delegate may not apply here; use the conflict_* tools, which work identically for every repo.",
    opts.escalationContext ? `Additional context: ${opts.escalationContext}` : "",
    mergeTreeOutput ? `\nmerge-tree dry-run output:\n${mergeTreeOutput.slice(0, 4000)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Wait for a conflict session to reach a terminal state.
 *
 *  Three things can end the wait:
 *   - the session settles (`conflict_complete` / `conflict_abandon` / the
 *     pane's abandon / a failure inside the tools);
 *   - the agent's run ends while the session is still `working` and there is
 *     no pending decision — meaning the agent finished (or died) without
 *     saying so, which is FINALIZED here against the real repo state. This is
 *     also the FR-023 path: on the source repo the agent resolves through
 *     `dev_delegate` and commits itself, and a clean tree is exactly what the
 *     pre-035 pipeline already treated as success;
 *   - the working-phase budget elapses. `awaiting-user` NEVER counts toward
 *     it (D3) — `lastWorkingAt` is reset on every transition into `working`. */
async function waitForSession(
  sessionId: string,
  maxWorkingMs: number,
  repoPath: string,
  remote: string | undefined,
): Promise<ConflictSession> {
  for (;;) {
    const session = await getSession(sessionId);
    if (!session) throw makeError("SESSION_LOST", `conflict session ${sessionId} disappeared mid-resolution`);
    if (isTerminalStatus(session.status)) return session;

    if (session.status === "working") {
      const run = session.runId ? runManager().get(session.runId) : undefined;
      const runDead = !session.runId || !run || run.status !== "running";
      if (runDead) {
        const finalized = await finalizeAfterRunEnd(session, run?.error);
        if (finalized) return finalized;
      }
      if (Date.now() - session.lastWorkingAt > maxWorkingMs) {
        gitLogger().warn({
          op: `${OP}.escalate.timeout`,
          repoPath,
          remote,
          success: false,
          error: { code: "ESCALATION_TIMED_OUT", message: `conflict session ${sessionId} exceeded ${maxWorkingMs}ms of continuous working time` },
        });
        return timeoutSession(sessionId, `the agent's working phase exceeded ${Math.round(maxWorkingMs / 60000)} minutes`);
      }
    }
    await new Promise((r) => setTimeout(r, SESSION_POLL_MS));
  }
}

/** The agent's run ended while the session was still `working`. Decide what
 *  actually happened by looking at the repo, never by assuming. */
async function finalizeAfterRunEnd(session: ConflictSession, runError: string | undefined): Promise<ConflictSession | undefined> {
  // Give the tools a beat to settle the session themselves — `conflict_complete`
  // finishes fractionally after the run it was called from.
  await new Promise((r) => setTimeout(r, 250));
  const fresh = await getSession(session.id);
  if (!fresh) return undefined;
  if (isTerminalStatus(fresh.status)) return fresh;
  if (fresh.status === "awaiting-user") return undefined; // parked — keep waiting
  if (fresh.runId && runManager().get(fresh.runId)?.status === "running") return undefined; // re-woken

  const outstanding = fresh.files.filter((f) => f.resolvedContent === undefined && !f.waived);
  if (outstanding.length === 0 && fresh.files.length > 0) {
    // Everything is resolved but the agent never called conflict_complete —
    // complete it rather than stranding a finished resolution.
    return completeSession(fresh.id, "completed after the agent's run ended");
  }

  // Nothing recorded through the tools. The agent may still have resolved it
  // another way (the source path's `dev_delegate`), which the pre-035
  // pipeline detected exactly like this: a clean working tree.
  const status = await runGitCommand(["status", "--porcelain"], { cwd: fresh.workContext.repoPath });
  if (fresh.workContext.mode === "working-tree" && status.exitCode === 0 && status.stdout.trim() === "") {
    return completeSession(fresh.id, "resolved by the agent outside the conflict tools (working tree is clean)");
  }
  return failSession(
    fresh.id,
    runError
      ? `the conflict-resolution agent's run ended with an error: ${runError}`
      : `the conflict-resolution agent's run ended with ${outstanding.length} file(s) still unresolved: ${outstanding.map((f) => f.path).join(", ")}`,
  );
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

  // Concurrent-op guard (S12). Checked against the durable session store as
  // well as the in-memory map, so a session that survived a restart — or one
  // parked in `awaiting-user` for hours — still re-points instead of starting
  // a parallel pipeline against the same repo.
  const existingEscalation = inFlightEscalations.get(repoPath) ?? (await activeEscalationFor(repoPath));
  if (existingEscalation) {
    const existing = await getSession(existingEscalation.sessionId).catch(() => undefined);
    gitLogger().info({ op: `${OP}.already-escalated`, repoPath, remote, success: true, error: undefined });
    opts.onEscalate?.(existingEscalation.conversationId, existingEscalation.sessionId);
    return {
      status: "escalated",
      rollbackTag: existing?.rollbackTag ?? "",
      devopsConversationId: existingEscalation.conversationId,
      sessionId: existingEscalation.sessionId,
      sessionStatus: existing?.status,
    };
  }

  const release = await gitLock().acquire(repoPath, OP);
  let lockReleased = false;
  const releaseLock = async (): Promise<void> => {
    if (lockReleased) return;
    lockReleased = true;
    await release();
  };

  const rollbackTag = `bos/pre-reconcile-${tagStamp()}`;
  const warnings: string[] = [];

  // 035: the no-working-tree path. When the repo's primary checkout is busy
  // (a detached HEAD), there is nothing to merge INTO
  // on disk — HEAD belongs to whoever has it checked out. Steps 2–4 all
  // operate on the working tree, so they are skipped entirely and the
  // pipeline goes straight to a session whose resolutions are landed with
  // commit-tree/update-ref. The caller has already established (via a
  // merge-tree dry run) that this genuinely conflicts.
  const plumbing = opts.mode === "plumbing";
  const plumbingBase = opts.completion?.plumbingBaseBranch;
  if (plumbing && !plumbingBase) {
    await releaseLock();
    return {
      status: "failed",
      rollbackTag: "",
      error: makeError("MISSING_PLUMBING_BASE", "a plumbing-mode reconciliation requires completion.plumbingBaseBranch (the branch ref to advance)."),
    };
  }

  try {
    // Step 1: rollback tag — always first, so the pre-reconciliation state is
    // recoverable no matter how the rest of the pipeline goes.
    await createTag(
      repoPath,
      rollbackTag,
      `Pre-reconciliation snapshot before merging ${sourceRef}${branch ? ` onto ${branch}` : ""}`,
      plumbing ? plumbingBase : undefined,
    );

    if (!plumbing) {
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
    const strategyResult = await attemptStrategy(repoPath, sourceRef, strategy, warnings);
    if (strategyResult.status === "success") {
      gitLogger().info({ op: OP, repoPath, remote, success: true, error: undefined });
      await releaseLock();
      return { status: "success", method: strategy, rollbackTag, ...(warnings.length ? { warnings } : {}) };
    }
    if (strategyResult.status === "failed") {
      gitLogger().error({ op: OP, repoPath, remote, success: false, error: strategyResult.error });
      await releaseLock();
      return { status: "failed", rollbackTag, error: strategyResult.error, ...(warnings.length ? { warnings } : {}) };
    }

    // Step 4: scripted rebase-based fallback.
    const rebaseResult = await attemptRebaseFallback(repoPath, sourceRef, warnings);
    if (rebaseResult.status === "success") {
      gitLogger().info({ op: OP, repoPath, remote, success: true, error: undefined });
      await releaseLock();
      return { status: "success", method: "rebase-fallback", rollbackTag, ...(warnings.length ? { warnings } : {}) };
    }
    if (rebaseResult.status === "failed") {
      gitLogger().error({ op: OP, repoPath, remote, success: false, error: rebaseResult.error });
      await releaseLock();
      return { status: "failed", rollbackTag, error: rebaseResult.error, ...(warnings.length ? { warnings } : {}) };
    }
    }

    // Step 5: escalate to the conflict-resolution agent.
    gitLogger().warn({
      op: `${OP}.escalate`,
      repoPath,
      remote,
      success: false,
      error: {
        code: "RECONCILE_UNRESOLVED",
        message: plumbing
          ? "no working tree available (plumbing mode) — the conflict is escalated directly"
          : `configured strategy (${strategy}) and the scripted rebase fallback both conflicted`,
      },
    });

    // The snapshot comes from REFS, not merge-index stages: steps 3–4 above
    // already aborted the merge/rebase, so `:1:`/`:2:`/`:3:` are gone. The
    // three refs survive both that abort and a process restart, which is
    // exactly what makes the session resumable (FR-002).
    const oursRef = plumbing ? plumbingBase! : await currentOursRef(repoPath);
    const { snapshot, raw } = await captureSnapshot(repoPath, oursRef, sourceRef);
    const workContext = await buildWorkContext(opts, oursRef, snapshot.base);
    const agentId = await conflictAgentId();

    const conversationId = await createDevOpsConversation(
      agentId,
      opts.featureBranchForDelegate,
      `Resolve conflict: ${sourceRef}${branch ? ` → ${remote}/${branch}` : ""}`,
    );

    const session = await createSession({
      workContext,
      featureBranch: opts.featureBranchForDelegate ?? sourceRef,
      baseBranch: branch ?? oursRef,
      rollbackTag,
      conversationId,
      agentId,
      snapshot,
      completion: {
        kind: opts.completion?.kind ?? (workContext.mode === "plumbing" ? "plumbing-merge" : "merge"),
        strategy: opts.completion?.strategy ?? strategy,
        plumbingBaseBranch: opts.completion?.plumbingBaseBranch,
        ff: opts.completion?.ff,
        pruneWorktree: opts.completion?.pruneWorktree,
      },
      operationLabel: opts.operationLabel ?? "reconcile",
      warnings,
    });
    await tagConversationWithSession(conversationId, session.id);

    inFlightEscalations.set(repoPath, { conversationId, sessionId: session.id });
    gitLogger().info({ op: `${OP}.escalate`, repoPath, remote, success: true, error: undefined });

    // FR-007: auto-launch. Emitting BEFORE the run starts means the pane is
    // already up while the agent does its first pass.
    await emitEscalatedEvent(session);
    opts.onEscalate?.(conversationId, session.id);

    const task = buildEscalationTask({
      opts,
      session,
      rollbackTag,
      strategy,
      mergeTreeOutput: raw,
    });

    let run: Awaited<ReturnType<typeof startAssistantRun>>;
    try {
      run = await startAssistantRun({ conversationId, agentId, message: task });
      await setSessionRun(session.id, run.id);
    } catch (e) {
      await releaseLock();
      const message = (e as Error).message ?? String(e);
      // FR-021 / FR-025: an agent that cannot be started (missing, no tools,
      // …) fails LOUDLY with the rollback tag — never a silent success.
      await failSession(session.id, `could not start the conflict-resolution agent "${agentId}": ${message}`).catch(() => undefined);
      inFlightEscalations.delete(repoPath);
      return {
        status: "failed",
        rollbackTag,
        devopsConversationId: conversationId,
        sessionId: session.id,
        sessionStatus: "failed",
        error: makeError("ESCALATION_AGENT_FAILED", message),
        ...(warnings.length ? { warnings } : {}),
      };
    } finally {
      // Release BEFORE the (potentially long) wait — the escalation's own git
      // work happens through the agent's tools, not through this pipeline's
      // lock hold, and the lock's own auto-release is 30s anyway.
      await releaseLock();
    }

    // Wait for the SESSION (not the run) to settle. Under park-and-rewake a
    // run ends every time the agent asks the user something, so run
    // completion is no longer the same event as resolution — and a parked
    // `awaiting-user` session waits indefinitely by design (D3), with the
    // 25-minute budget applying only to continuous `working` time (§9.3).
    const settled = await waitForSession(session.id, maxEscalationWaitMs, repoPath, remote);
    inFlightEscalations.delete(repoPath);

    const final = (await getSession(session.id)) ?? settled;
    const runStatus = runManager().get(final.runId ?? run.id)?.status;
    gitLogger().info({
      op: `${OP}.escalate.finished`,
      repoPath,
      remote,
      success: final.status === "resolved",
      error: final.result?.error ? { code: "CONFLICT_AGENT_ERROR", message: final.result.error } : undefined,
    });
    const allWarnings = [...warnings, ...final.warnings.filter((w) => !warnings.includes(w))];

    if (final.status === "timed-out") {
      return {
        status: "timed-out",
        rollbackTag,
        devopsConversationId: conversationId,
        sessionId: session.id,
        sessionStatus: final.status,
        runStatus,
        ...(allWarnings.length ? { warnings: allWarnings } : {}),
      };
    }
    if (final.status === "failed" || final.status === "abandoned") {
      // Never report a non-resolution as "escalated and clean" — a caller
      // that trusted that (the Supervisor's requireReconciled) would happily
      // promote an unmerged branch. PR-4: the user always has the wheel, and
      // the rollback tag is how they take it.
      return {
        status: "failed",
        rollbackTag,
        devopsConversationId: conversationId,
        sessionId: session.id,
        sessionStatus: final.status,
        runStatus,
        error: makeError(
          final.status === "abandoned" ? "CONFLICT_ABANDONED" : "CONFLICT_UNRESOLVED",
          final.result?.error ?? final.result?.reason ?? "the conflict resolution did not complete",
          `Restore the pre-reconciliation state with \`git reset --hard ${rollbackTag}\`, then retry.`,
        ),
        ...(allWarnings.length ? { warnings: allWarnings } : {}),
      };
    }

    return {
      status: "escalated",
      method: "devops-agent",
      rollbackTag,
      devopsConversationId: conversationId,
      sessionId: session.id,
      sessionStatus: final.status,
      runStatus,
      ...(allWarnings.length ? { warnings: allWarnings } : {}),
    };
  } catch (e) {
    const gitErr = e as GitError;
    const error = { code: gitErr.code ?? "RECONCILE_FAILED", message: gitErr.message ?? String(e), suggestion: gitErr.suggestion };
    gitLogger().error({ op: OP, repoPath, remote, success: false, error });
    return { status: "failed", rollbackTag, error, ...(warnings.length ? { warnings } : {}) };
  } finally {
    await releaseLock();
  }
}
