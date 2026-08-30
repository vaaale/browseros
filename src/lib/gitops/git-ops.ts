import "server-only";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { gitLogger } from "./logging";
import type { GitAuth } from "./auth";
import { buildCredentialConfig } from "./git-credential-helper";
import { getGitIdentity } from "@/lib/config/store";

// Core git operations — thin wrappers around the git CLI. Auth and locking are
// the caller's responsibility. All functions use `spawn` (not `exec`) for
// security and streaming capability.

export type MergeStrategy = "merge" | "merge-squash" | "commit";

export interface GitError {
  code: string;
  message: string;
  suggestion?: string;
}

export interface AheadBehind {
  ahead: number;
  behind: number;
}

export interface RemoteInfo {
  name: string;
  url: string;
}

export interface TestConnectionResult {
  ok: boolean;
  branches: string[];
  error?: string;
}

export interface MergeResult {
  status: "success" | "conflict";
  commitHash?: string;
}

export interface RebaseResult {
  status: "success" | "conflict";
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function authEnv(auth?: GitAuth): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
  if (auth?.type === "ssh" && auth.sshKeyPath) {
    env.GIT_SSH_COMMAND = `ssh -i "${auth.sshKeyPath}" -o StrictHostKeyChecking=no -o BatchMode=yes`;
  }
  return env;
}

async function runGit(
  args: string[],
  opts: {
    cwd?: string;
    auth?: GitAuth;
    timeout?: number;
    /** Extra environment for this ONE invocation (e.g. `GIT_INDEX_FILE` for a
     *  plumbing merge against a scratch index). Passed per-spawn rather than
     *  set on `process.env`, which would race every concurrent git call. */
    env?: Record<string, string>;
  } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // Wire up the credential helper so HTTPS token/OAuth auth works for
  // named-remote operations (fetch/push) where the token isn't in the URL.
  // Returns empty for SSH/unauthenticated ops, so this is safe to apply always.
  const cred = await buildCredentialConfig(opts.auth);
  const finalArgs = cred.args.length ? [...cred.args, ...args] : args;

  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn("git", finalArgs, {
      cwd: opts.cwd,
      env: { ...process.env, ...authEnv(opts.auth), ...cred.env, ...(opts.env ?? {}) },
      timeout: opts.timeout,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      reject(makeError("GIT_SPAWN_FAILED", `git spawn failed: ${err.message}`));
    });

    child.on("close", (code) => {
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? 1 });
    });
  });
}

/** Public escape hatch onto the raw git CLI (same auth/credential wiring as
 *  every other function here) for callers that need to operate on an
 *  arbitrary ref rather than a `<remote>/<branch>` pair — e.g. the shared
 *  reconciliation pipeline (`reconcile.ts`), which merges a local feature
 *  branch onto a local base branch (no remote involved in that specific
 *  step) as well as remote-tracking refs. Callers own their own logging. */
export async function runGitCommand(
  args: string[],
  opts: { cwd?: string; auth?: GitAuth; timeout?: number; env?: Record<string, string> } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return runGit(args, opts);
}

export function makeError(code: string, message: string, suggestion?: string): GitError {
  return { code, message, suggestion };
}

function parseAheadBehind(output: string): AheadBehind {
  // `git rev-list --left-right --count <remote>/<branch>...HEAD` — the LEFT
  // side (first, before "...") is the remote ref, so its count is commits
  // only on the remote (BEHIND); the RIGHT side is HEAD, so its count is
  // commits only locally (AHEAD). Verified empirically: a repo missing one
  // remote commit and with no local-only commits prints "1\t0", not "0\t1".
  const parts = output.split("\t");
  return {
    behind: parseInt(parts[0] ?? "0", 10) || 0,
    ahead: parseInt(parts[1] ?? "0", 10) || 0,
  };
}

function isAuthFailure(stderr: string): boolean {
  return (
    /authentication/i.test(stderr) ||
    /Permission denied/i.test(stderr) ||
    /fatal: .*(?:token|credential)/i.test(stderr) ||
    /401/.test(stderr) ||
    /403/.test(stderr) ||
    // Headless credential resolution failed entirely (no embedded URL token,
    // no working credential helper, no SSH key) — git wanted to prompt
    // interactively and couldn't, since GIT_TERMINAL_PROMPT=0 is always set.
    /could not read (username|password)/i.test(stderr) ||
    /terminal prompts disabled/i.test(stderr)
  );
}

export function isMergeConflict(stderr: string): boolean {
  return /CONFLICT/i.test(stderr) || /merge failed/i.test(stderr);
}

/**
 * A committer identity for a history-writing git command, used ONLY when the
 * repo (and the environment) doesn't already have one.
 *
 * Every repo BOS manages that BOS itself created — a spec store, `user-apps`,
 * a VFS mount clone — is a bare `git init` with no `user.email`, and a
 * container image typically has no global identity either. `git tag -a`,
 * `git commit` and `git merge` all HARD-FAIL in that state ("Committer
 * identity unknown"), which would take out the reconciliation pipeline at its
 * very first step: creating the rollback tag. That tag is the feature's whole
 * safety guarantee (FR-017), so it must not depend on the host's git config.
 *
 * Never overrides a real configured identity — a user who has set one keeps
 * getting their own name on BOS-made commits. The fallback identity itself is
 * user-configurable (Settings → Versions → Git identity, namespace
 * "self-modification"), defaulting to "BrowserOS" <bos@localhost> when unset.
 */
export async function gitIdentityEnv(repoPath: string): Promise<Record<string, string>> {
  const configured = await runGit(["config", "user.email"], { cwd: repoPath });
  if (configured.exitCode === 0 && configured.stdout.trim()) return {};
  if (process.env.GIT_AUTHOR_EMAIL || process.env.GIT_COMMITTER_EMAIL || process.env.EMAIL) return {};
  const { name, email } = await getGitIdentity();
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

// ── Operations ───────────────────────────────────────────────────────────────

export async function cloneRepo(
  url: string,
  targetPath: string,
  branch?: string,
  auth?: GitAuth,
): Promise<void> {
  const op = "git.clone";
  // Auth is supplied to git via the credential helper (see runGit), never
  // embedded in the URL — embedding breaks git's URL parser (the token's `:`
  // is misread as a port separator) and leaks the token into argv.
  const args = ["clone", url, targetPath];
  if (branch) args.splice(2, 0, "--branch", branch, "--single-branch");

  gitLogger().debug({ op, repoPath: targetPath, remote: url });
  const t0 = Date.now();

  const { stdout, stderr, exitCode } = await runGit(args, { auth });
  const durationMs = Date.now() - t0;

  if (exitCode !== 0) {
    const code = isAuthFailure(stderr) ? "GIT_AUTH_FAILURE" : "GIT_CLONE_FAILED";
    const suggestion = code === "GIT_AUTH_FAILURE"
      ? "Check your credentials in Settings → Git Providers."
      : undefined;
    gitLogger().error({ op, repoPath: targetPath, remote: url, durationMs, success: false, error: { code, message: stderr || stdout, suggestion } });
    throw makeError(code, stderr || stdout, suggestion);
  }

  gitLogger().info({ op, repoPath: targetPath, remote: url, durationMs, success: true });
}

export async function fetchRepo(
  repoPath: string,
  remote?: string,
  branch?: string,
  auth?: GitAuth,
): Promise<AheadBehind> {
  const op = "git.fetch";
  const args = ["fetch", remote ?? "all"];
  if (branch) args.push(branch);

  gitLogger().debug({ op, repoPath, remote });
  const t0 = Date.now();

  const { stdout, stderr, exitCode } = await runGit(args, { cwd: repoPath, auth });
  const durationMs = Date.now() - t0;

  if (exitCode !== 0) {
    const code = isAuthFailure(stderr) ? "GIT_AUTH_FAILURE" : "GIT_FETCH_FAILED";
    const suggestion = code === "GIT_AUTH_FAILURE"
      ? "Check your credentials in Settings → Git Providers."
      : undefined;
    gitLogger().error({ op, repoPath, remote, durationMs, success: false, error: { code, message: stderr || stdout, suggestion } });
    throw makeError(code, stderr || stdout, suggestion);
  }

  // Compute ahead/behind against the remote. A failure here must NOT default
  // to {ahead:0, behind:0} — that reads to callers as "already up to date"
  // and skips the fast-forward/rebase below, silently leaving a genuinely
  // behind branch untouched (a real fetch had just succeeded moments before,
  // so this looks identical to "nothing new" from the caller's side).
  const target = remote ?? "origin";
  const branchArg = branch ?? await getCurrentBranch(repoPath);
  const ab = await runGit(
    ["rev-list", "--left-right", "--count", `${target}/${branchArg}...HEAD`],
    { cwd: repoPath, auth },
  );
  if (ab.exitCode !== 0) {
    gitLogger().error({
      op,
      repoPath,
      remote: target,
      durationMs,
      success: false,
      error: { code: "GIT_REV_LIST_FAILED", message: ab.stderr || ab.stdout },
    });
    throw makeError("GIT_REV_LIST_FAILED", ab.stderr || ab.stdout);
  }
  const result = parseAheadBehind(ab.stdout);

  gitLogger().info({ op, repoPath, remote: target, durationMs, success: true });
  return result;
}

/** True when `repoPath` is a shallow clone (has no complete history). */
export async function isShallowRepo(repoPath: string): Promise<boolean> {
  const { stdout, exitCode } = await runGit(["rev-parse", "--is-shallow-repository"], { cwd: repoPath });
  return exitCode === 0 && stdout.trim() === "true";
}

/**
 * Deepen a shallow clone by fetching full history from `remote`. A shallow
 * checkout — e.g. BrowserOS's own source tree, which Dokploy re-clones with
 * `--depth 1` on every redeploy (see docs/dev/deployment.md) — has no
 * connecting history to prove a local branch descends from the remote's, so
 * merge-base/ahead-behind checks against it are unreliable until this runs.
 * Never fatal: an unreachable remote, or a shallow history that's genuinely
 * disconnected from `remote`, just leaves the repo shallow and callers fall
 * back to the existing diverged/unrelated-history handling.
 */
export async function unshallowRepo(
  repoPath: string,
  remote: string,
  auth?: GitAuth,
): Promise<void> {
  const op = "git.unshallow";
  const { stderr, exitCode } = await runGit(
    ["fetch", "--unshallow", remote],
    { cwd: repoPath, auth, timeout: 600_000 },
  );
  if (exitCode !== 0) {
    gitLogger().warn({ op, repoPath, remote, error: { code: "GIT_UNSHALLOW_FAILED", message: stderr } });
    return;
  }
  gitLogger().info({ op, repoPath, remote, success: true });
}

export async function pushRepo(
  repoPath: string,
  remote: string,
  branch: string,
  auth?: GitAuth,
  opts: { force?: boolean } = {},
): Promise<void> {
  const op = "git.push";
  // --force-with-lease (not --force): fails instead of overwriting if the
  // remote moved since our last fetch of it, so an explicit user-requested
  // force-push still can't silently clobber someone else's concurrent push.
  const args = opts.force ? ["push", "--force-with-lease", remote, branch] : ["push", remote, branch];

  gitLogger().debug({ op, repoPath, remote, durationMs: undefined });
  const t0 = Date.now();

  const { stdout, stderr, exitCode } = await runGit(args, { cwd: repoPath, auth });
  const durationMs = Date.now() - t0;

  if (exitCode !== 0) {
    const code = isAuthFailure(stderr) ? "GIT_AUTH_FAILURE" : "GIT_PUSH_FAILED";
    const suggestion = code === "GIT_AUTH_FAILURE"
      ? "Check your credentials in Settings → Git Providers."
      : "Verify the remote is accessible and the branch exists.";
    gitLogger().error({ op, repoPath, remote, durationMs, success: false, error: { code, message: stderr || stdout, suggestion } });
    throw makeError(code, stderr || stdout, suggestion);
  }

  gitLogger().info({ op, repoPath, remote, durationMs, success: true });
}

export async function listRemoteBranches(
  url: string,
  auth?: GitAuth,
): Promise<string[]> {
  const op = "git.listRemoteBranches";

  gitLogger().debug({ op, remote: url });
  const t0 = Date.now();

  // Auth is supplied via the credential helper (see runGit), not the URL.
  const { stdout, stderr, exitCode } = await runGit(
    ["ls-remote", "--heads", url],
    { auth },
  );
  const durationMs = Date.now() - t0;

  if (exitCode !== 0) {
    const code = isAuthFailure(stderr) ? "GIT_AUTH_FAILURE" : "GIT_LS_REMOTE_FAILED";
    gitLogger().error({ op, remote: url, durationMs, success: false, error: { code, message: stderr } });
    throw makeError(code, stderr || stdout);
  }

  const branches = stdout
    .split("\n")
    .map((line) => {
      const match = line.match(/refs\/heads\/(.+)/);
      return match ? match[1] : null;
    })
    .filter((b): b is string => b !== null);

  gitLogger().info({ op, remote: url, durationMs, success: true });
  return branches;
}

export async function addRemote(
  repoPath: string,
  name: string,
  url: string,
): Promise<void> {
  const op = "git.addRemote";
  gitLogger().debug({ op, repoPath, remote: name });
  const t0 = Date.now();

  const { stderr, exitCode } = await runGit(
    ["remote", "add", name, url],
    { cwd: repoPath },
  );
  const durationMs = Date.now() - t0;

  if (exitCode !== 0) {
    gitLogger().error({ op, repoPath, remote: name, durationMs, success: false, error: { code: "GIT_REMOTE_ADD_FAILED", message: stderr } });
    throw makeError("GIT_REMOTE_ADD_FAILED", stderr);
  }

  gitLogger().info({ op, repoPath, remote: name, durationMs, success: true });
}

export async function removeRemote(
  repoPath: string,
  name: string,
): Promise<void> {
  const op = "git.removeRemote";
  gitLogger().debug({ op, repoPath, remote: name });
  const t0 = Date.now();

  const { stderr, exitCode } = await runGit(
    ["remote", "remove", name],
    { cwd: repoPath },
  );
  const durationMs = Date.now() - t0;

  if (exitCode !== 0) {
    gitLogger().error({ op, repoPath, remote: name, durationMs, success: false, error: { code: "GIT_REMOTE_REMOVE_FAILED", message: stderr } });
    throw makeError("GIT_REMOTE_REMOVE_FAILED", stderr);
  }

  gitLogger().info({ op, repoPath, remote: name, durationMs, success: true });
}

export async function setRemoteUrl(
  repoPath: string,
  name: string,
  url: string,
): Promise<void> {
  const op = "git.setRemoteUrl";
  const { stderr, exitCode } = await runGit(
    ["remote", "set-url", name, url],
    { cwd: repoPath },
  );
  if (exitCode !== 0) {
    gitLogger().error({ op, repoPath, remote: name, success: false, error: { code: "GIT_REMOTE_SET_URL_FAILED", message: stderr } });
    throw makeError("GIT_REMOTE_SET_URL_FAILED", stderr);
  }
  gitLogger().info({ op, repoPath, remote: name, success: true });
}

export async function renameRemote(
  repoPath: string,
  oldName: string,
  newName: string,
): Promise<void> {
  const op = "git.renameRemote";
  const { stderr, exitCode } = await runGit(
    ["remote", "rename", oldName, newName],
    { cwd: repoPath },
  );
  if (exitCode !== 0) {
    gitLogger().error({ op, repoPath, remote: oldName, success: false, error: { code: "GIT_REMOTE_RENAME_FAILED", message: stderr } });
    throw makeError("GIT_REMOTE_RENAME_FAILED", stderr);
  }
  gitLogger().info({ op, repoPath, remote: newName, success: true });
}

export async function listRemotes(
  repoPath: string,
): Promise<RemoteInfo[]> {
  const op = "git.listRemotes";
  gitLogger().debug({ op, repoPath });
  const t0 = Date.now();

  const { stdout, stderr, exitCode } = await runGit(
    ["remote", "-v"],
    { cwd: repoPath },
  );
  const durationMs = Date.now() - t0;

  if (exitCode !== 0) {
    throw makeError("GIT_LIST_REMOTES_FAILED", stderr);
  }

  const remotes: RemoteInfo[] = [];
  const lines = stdout.split("\n").filter(Boolean);
  const seen = new Set<string>();
  for (const line of lines) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\(.*\)$/);
    if (match && !seen.has(match[1])) {
      seen.add(match[1]);
      remotes.push({ name: match[1], url: match[2] });
    }
  }

  gitLogger().info({ op, repoPath, durationMs, success: true });
  return remotes;
}

export async function getDefaultBranch(
  url: string,
  auth?: GitAuth,
): Promise<string> {
  const op = "git.getDefaultBranch";

  gitLogger().debug({ op, remote: url });
  const t0 = Date.now();

  // Auth is supplied via the credential helper (see runGit), not the URL.
  const { stdout, stderr, exitCode } = await runGit(
    ["ls-remote", "--symref", url, "HEAD"],
    { auth },
  );
  const durationMs = Date.now() - t0;

  if (exitCode !== 0) {
    throw makeError("GIT_LS_REMOTE_FAILED", stderr || stdout);
  }

  // Parse: "ref: refs/heads/main\tHEAD\nabc123\tHEAD"
  const match = stdout.match(/ref: refs\/heads\/(\S+)\s+HEAD/);
  const branch = match ? match[1] : "main";

  gitLogger().info({ op, remote: url, durationMs, success: true });
  return branch;
}

export async function getCurrentBranch(
  repoPath: string,
): Promise<string> {
  const op = "git.getCurrentBranch";
  const { stdout, exitCode } = await runGit(
    ["rev-parse", "--abbrev-ref", "HEAD"],
    { cwd: repoPath },
  );
  if (exitCode !== 0) {
    gitLogger().error({ op, repoPath, success: false, error: { code: "GIT_CURRENT_BRANCH_FAILED", message: "Could not determine current branch" } });
    throw makeError("GIT_CURRENT_BRANCH_FAILED", "Could not determine current branch");
  }
  gitLogger().debug({ op, repoPath, success: true });
  return stdout;
}

/**
 * The merge-base commit between HEAD and `<remote>/<branch>`, or null if the
 * two share no common ancestor (unrelated histories) — e.g. a remote that
 * already contained its own content before being registered. Caller must have
 * already fetched so the remote-tracking ref exists.
 */
export async function getMergeBase(
  repoPath: string,
  remote: string,
  branch: string,
): Promise<string | null> {
  const op = "git.getMergeBase";
  const { stdout, exitCode } = await runGit(
    ["merge-base", "HEAD", `${remote}/${branch}`],
    { cwd: repoPath },
  );
  const result = exitCode === 0 && stdout ? stdout.trim() : null;
  gitLogger().debug({ op, repoPath, remote, success: result !== null });
  return result;
}

/** True if `ancestor` is an ancestor of (or equal to) `ref`. */
export async function isAncestor(
  repoPath: string,
  ancestor: string,
  ref: string,
): Promise<boolean> {
  const op = "git.isAncestor";
  const { exitCode } = await runGit(
    ["merge-base", "--is-ancestor", ancestor, ref],
    { cwd: repoPath },
  );
  const result = exitCode === 0;
  gitLogger().debug({ op, repoPath, success: result });
  return result;
}

/** Fast-forward the current branch to `<remote>/<branch>`. Only safe when
 *  `isAncestor(repoPath, "HEAD", "<remote>/<branch>")` is true. */
export async function fastForwardMerge(
  repoPath: string,
  remote: string,
  branch: string,
): Promise<void> {
  const op = "git.fastForwardMerge";
  const { stderr, exitCode } = await runGit(
    ["merge", "--ff-only", `${remote}/${branch}`],
    { cwd: repoPath },
  );
  if (exitCode !== 0) {
    gitLogger().error({ op, repoPath, remote, success: false, error: { code: "GIT_FF_MERGE_FAILED", message: stderr } });
    throw makeError("GIT_FF_MERGE_FAILED", stderr);
  }
  gitLogger().info({ op, repoPath, remote, success: true });
}

export interface AdoptResult {
  /** Name of the branch created to preserve pre-adopt HEAD. */
  backupBranch: string;
}

/**
 * Replace the current branch's content with `<remote>/<branch>` — for
 * adopting a remote whose history is unrelated to local (e.g. a pre-existing
 * repo that already has its own commits). ALWAYS creates a backup branch
 * pointing at the pre-adopt HEAD first, so nothing is destroyed. Caller must
 * have already fetched so the remote-tracking ref exists.
 */
export async function adoptRemote(
  repoPath: string,
  remote: string,
  branch: string,
): Promise<AdoptResult> {
  const op = "git.adoptRemote";
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const backupBranch = `backup-before-adopt-${stamp}`;

  const branchResult = await runGit(["branch", backupBranch], { cwd: repoPath });
  if (branchResult.exitCode !== 0) {
    gitLogger().error({ op, repoPath, remote, success: false, error: { code: "GIT_ADOPT_BACKUP_FAILED", message: branchResult.stderr } });
    throw makeError("GIT_ADOPT_BACKUP_FAILED", branchResult.stderr);
  }

  const resetResult = await runGit(["reset", "--hard", `${remote}/${branch}`], { cwd: repoPath });
  if (resetResult.exitCode !== 0) {
    gitLogger().error({ op, repoPath, remote, success: false, error: { code: "GIT_ADOPT_FAILED", message: resetResult.stderr } });
    throw makeError("GIT_ADOPT_FAILED", resetResult.stderr);
  }

  gitLogger().info({ op, repoPath, remote: `${remote} (backup: ${backupBranch})`, success: true });
  return { backupBranch };
}

export async function testConnection(
  url: string,
  auth?: GitAuth,
): Promise<TestConnectionResult> {
  const op = "git.testConnection";

  gitLogger().debug({ op, remote: url });
  const t0 = Date.now();

  try {
    // Pass the plain URL; auth flows through the credential helper (runGit).
    const branches = await listRemoteBranches(url, auth);
    const durationMs = Date.now() - t0;
    gitLogger().info({ op, remote: url, durationMs, success: true });
    return { ok: true, branches };
  } catch (err) {
    const durationMs = Date.now() - t0;
    const gitErr = err as GitError;
    gitLogger().warn({ op, remote: url, durationMs, success: false, error: gitErr });
    return { ok: false, branches: [], error: gitErr.message };
  }
}

export async function mergeBranch(
  repoPath: string,
  remote: string,
  branch: string,
  strategy: MergeStrategy,
): Promise<MergeResult> {
  const op = "git.merge";
  gitLogger().debug({ op, repoPath, remote });
  const t0 = Date.now();

  if (strategy === "commit") {
    // AD-002: stash local → squash merge remote → commit → pop stash.
    await stashChanges(repoPath);
    try {
      const { stderr: mergeErr, exitCode: mergeCode } = await runGit(
        ["merge", "--squash", `${remote}/${branch}`],
        { cwd: repoPath },
      );
      if (mergeCode !== 0 && isMergeConflict(mergeErr)) {
        const durationMs = Date.now() - t0;
        // merge --squash never sets MERGE_HEAD — discard it with reset+clean
        // BEFORE popping the stash in `finally`, so the stash doesn't get
        // applied on top of a half-conflicted working tree.
        await resetHardAndClean(repoPath).catch(() => undefined);
        gitLogger().error({ op, repoPath, remote, durationMs, success: false, error: { code: "MERGE_CONFLICT", message: mergeErr } });
        throw makeError("MERGE_CONFLICT", mergeErr, "Resolve manually or try a different strategy.");
      }
      await runGit(
        ["commit", "-m", `Fetch remote changes from ${remote}/${branch}`],
        { cwd: repoPath, env: await gitIdentityEnv(repoPath) },
      );
    } finally {
      await popStash(repoPath);
    }
  } else {
    const args = strategy === "merge-squash"
      ? ["merge", "--squash", `${remote}/${branch}`]
      : ["merge", `${remote}/${branch}`];

    // "merge-squash" only stages — no commit, so no identity is needed for
    // it — but the plain "merge" strategy auto-commits on a non-fast-forward,
    // so it needs the same fallback identity as every other commit-writing
    // call here. Harmless to pass unconditionally either way.
    const { stderr, exitCode } = await runGit(args, { cwd: repoPath, env: await gitIdentityEnv(repoPath) });
    const durationMs = Date.now() - t0;

    if (exitCode !== 0 && isMergeConflict(stderr)) {
      // Abort cleanly before surfacing the conflict: `merge --squash` never
      // sets MERGE_HEAD (reset+clean is the only way to discard it); a real
      // `merge` conflict does, so `merge --abort` applies there.
      if (strategy === "merge-squash") {
        await resetHardAndClean(repoPath).catch(() => undefined);
      } else {
        await runGit(["merge", "--abort"], { cwd: repoPath }).catch(() => undefined);
      }
      gitLogger().error({ op, repoPath, remote, durationMs, success: false, error: { code: "MERGE_CONFLICT", message: stderr } });
      throw makeError("MERGE_CONFLICT", stderr, "Resolve manually or try a different strategy.");
    }
    if (exitCode !== 0) {
      gitLogger().error({ op, repoPath, remote, durationMs, success: false, error: { code: "GIT_MERGE_FAILED", message: stderr } });
      throw makeError("GIT_MERGE_FAILED", stderr);
    }
  }

  // Get current HEAD commit hash.
  const { stdout: hashOut } = await runGit(["rev-parse", "HEAD"], { cwd: repoPath });
  const durationMs = Date.now() - t0;

  gitLogger().info({ op, repoPath, remote, durationMs, success: true });
  return { status: "success", commitHash: hashOut };
}

/** Create an annotated tag on the current HEAD of `repoPath` — used as a
 *  rollback anchor before the reconciliation pipeline (US6) attempts any
 *  merge/rebase, so the pre-reconciliation state is always recoverable. */
export async function createTag(repoPath: string, tagName: string, message: string, ref?: string): Promise<void> {
  const op = "git.createTag";
  // `ref` matters for the no-working-tree (plumbing) reconciliation path: HEAD
  // there belongs to whatever else has the primary checkout busy, so the
  // rollback anchor must be pinned to the branch actually being advanced.
  const { stderr, exitCode } = await runGit(["tag", "-a", tagName, "-m", message, ...(ref ? [ref] : [])], {
    cwd: repoPath,
    env: await gitIdentityEnv(repoPath),
  });
  if (exitCode !== 0) {
    gitLogger().error({ op, repoPath, success: false, error: { code: "GIT_TAG_FAILED", message: stderr } });
    throw makeError("GIT_TAG_FAILED", stderr);
  }
  gitLogger().info({ op, repoPath, success: true });
}

// ── Three-way snapshot reads (035-spec-promote-conflict-escalation) ──────────
//
// The conflict snapshot is derived from REFS, never from `:1:`/`:2:`/`:3:`
// merge-index stages: `reconcile.ts` ABORTS the merge/rebase before it
// escalates, so by the time a session is created the stages no longer exist.
// Refs always do — which is also what makes a session restart-safe (the same
// three reads re-derive identical content after a process restart).

/** Raw (untrimmed, byte-exact) `git` invocation. `runGitCommand` trims its
 *  stdout, which is right for status/porcelain output and wrong for file
 *  content — a trailing newline is part of the file. */
async function runGitBuffer(
  args: string[],
  opts: { cwd?: string } = {},
): Promise<{ stdout: Buffer; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => chunks.push(c));
    child.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
    child.on("error", (err) => reject(makeError("GIT_SPAWN_FAILED", `git spawn failed: ${err.message}`)));
    child.on("close", (code) => resolve({ stdout: Buffer.concat(chunks), stderr: stderr.trim(), exitCode: code ?? 1 }));
  });
}

/** Read `<rel>`'s content at `<ref>` — the three-way snapshot primitive.
 *
 *  Returns `null` when the path does not exist at that ref. That is NOT an
 *  error condition: for an **add/add** conflict (the reported repro's shape)
 *  the merge-base is a perfectly valid commit that simply doesn't contain the
 *  file, so `git show <base>:<rel>` fails — the base side of the hunk is
 *  genuinely empty and the pane renders it as "(empty)".
 *
 *  NOTE: this is deliberately NOT `store-git.ts`'s same-named helper — that
 *  one is bound to the spec store; this one takes an arbitrary repo path. */
export async function readFileAtRef(repoPath: string, ref: string, rel: string): Promise<string | null> {
  const buf = await readFileAtRefBuffer(repoPath, ref, rel);
  return buf === null ? null : buf.toString("utf8");
}

/** Byte-exact variant — lets a caller detect a binary conflict (FR-022) by
 *  looking for a NUL byte instead of round-tripping through UTF-8. */
export async function readFileAtRefBuffer(repoPath: string, ref: string, rel: string): Promise<Buffer | null> {
  if (!ref) return null;
  const { stdout, exitCode } = await runGitBuffer(["show", `${ref}:${rel}`], { cwd: repoPath });
  if (exitCode !== 0) return null; // "path does not exist in <ref>" — add/add base side
  return stdout;
}

/** A blob with a NUL byte in its first 8k is binary as far as git (and this
 *  feature) is concerned — the agent must never "merge" one (FR-022). */
export function looksBinary(buf: Buffer | null): boolean {
  if (!buf) return false;
  return buf.subarray(0, 8000).includes(0);
}

export interface MergeTreeConflicts {
  /** Conflicting repo-relative paths. */
  files: string[];
  /** path → conflict kind, when git named one ("CONFLICT (add/add): …"). */
  types: Record<string, string>;
  /** Raw merge-tree output, for the escalation's context text. */
  raw: string;
}

/** Parse `git merge-tree --write-tree` output into the conflicting-file list.
 *
 *  Two independent signals are unioned so a rename/mode-only conflict that
 *  only shows up in one of them is never missed:
 *   - the "Conflicted file info" section: `<mode> <oid> <stage>\t<path>`
 *   - the informational messages: `CONFLICT (<kind>): Merge conflict in <path>`
 *     (and the `… in <path>` variants git emits for add/add and delete/modify). */
export function parseMergeTreeConflicts(output: string): MergeTreeConflicts {
  const files = new Set<string>();
  const types: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const stage = /^(\d{6}) ([0-9a-f]{40,64}) ([123])\t(.+)$/.exec(line.trim());
    if (stage) {
      files.add(stage[4]);
      continue;
    }
    const conflict = /^CONFLICT \(([^)]+)\)(?:\s*\[[^\]]*\])?:\s*(?:Merge conflict in|.*\bin)\s+(.+?)\s*$/.exec(line.trim());
    if (conflict) {
      const kind = conflict[1].toLowerCase();
      const p = conflict[2];
      files.add(p);
      types[p] = kind;
    }
  }
  return { files: [...files], types, raw: output };
}

/** Run the `merge-tree --write-tree` dry-run and report the conflicts, without
 *  touching the working tree. Used both by the pre-check call sites and by the
 *  snapshot capture on the plumbing path (where there is no working tree at
 *  all, so `diff --diff-filter=U` has nothing to report). */
export async function mergeTreeConflicts(
  repoPath: string,
  base: string,
  ours: string,
  theirs: string,
): Promise<MergeTreeConflicts | null> {
  const args = ["merge-tree", "--write-tree"];
  if (base) args.push(`--merge-base=${base}`);
  args.push(ours, theirs);
  const { stdout, stderr, exitCode } = await runGit(args, { cwd: repoPath });
  if (exitCode === 0) return null; // clean merge
  return parseMergeTreeConflicts(`${stdout}\n${stderr}`);
}

/** Produce a conflict-marker rendering of a three-way merge WITHOUT touching
 *  the repo — `git merge-file --diff3` over three temp files. This is what
 *  gives the pane real hunk granularity (FR-008) for a snapshot whose merge
 *  has already been aborted. Returns null if git couldn't run it. */
export async function mergeFileWithMarkers(
  base: string | null,
  ours: string,
  theirs: string,
  labels: { ours: string; base: string; theirs: string },
): Promise<string | null> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bos-conflict-"));
  try {
    const oursPath = path.join(dir, "ours");
    const basePath = path.join(dir, "base");
    const theirsPath = path.join(dir, "theirs");
    await fs.writeFile(oursPath, ours);
    await fs.writeFile(basePath, base ?? "");
    await fs.writeFile(theirsPath, theirs);
    const { stdout, exitCode } = await runGitBuffer(
      ["merge-file", "-p", "--diff3", "-L", labels.ours, "-L", labels.base, "-L", labels.theirs, oursPath, basePath, theirsPath],
      { cwd: dir },
    );
    // Exit code is the number of conflicts (>=0); only a negative/failed spawn
    // means it genuinely couldn't run.
    if (exitCode < 0) return null;
    return stdout.toString("utf8");
  } catch {
    return null;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Discard a failed `merge --squash` attempt. `merge --squash` never sets
 *  `MERGE_HEAD`, so `git merge --abort` doesn't apply — this is the correct
 *  way to fully discard it and any untracked files it left behind. */
export async function resetHardAndClean(repoPath: string, ref = "HEAD"): Promise<void> {
  const op = "git.resetHardAndClean";
  const reset = await runGit(["reset", "--hard", ref], { cwd: repoPath });
  if (reset.exitCode !== 0) {
    gitLogger().error({ op, repoPath, success: false, error: { code: "GIT_RESET_FAILED", message: reset.stderr } });
    throw makeError("GIT_RESET_FAILED", reset.stderr);
  }
  const clean = await runGit(["clean", "-fd"], { cwd: repoPath });
  if (clean.exitCode !== 0) {
    // Non-fatal — the reset already discarded tracked changes; leftover
    // untracked files are a cosmetic issue, not a correctness one.
    gitLogger().warn({ op, repoPath, error: { code: "GIT_CLEAN_FAILED", message: clean.stderr } });
    return;
  }
  gitLogger().info({ op, repoPath, success: true });
}

/**
 * Reconcile a diverged branch by replaying local-only commits on top of
 * `<remote>/<branch>` — the polite alternative to a force-push: nobody's
 * history is discarded, and a subsequent plain push succeeds as a normal
 * fast-forward. Stashes/restores any uncommitted changes around the rebase
 * (mirrors mergeBranch's "commit" strategy). On conflict, aborts the rebase
 * so the working tree is left exactly as it was — caller decides the next
 * step (manual merge, or an explicit force-push).
 */
export async function rebaseOntoRemote(
  repoPath: string,
  remote: string,
  branch: string,
): Promise<RebaseResult> {
  const op = "git.rebase";
  gitLogger().debug({ op, repoPath, remote });
  const t0 = Date.now();

  const dirty = await hasUncommittedChanges(repoPath);
  if (dirty) await stashChanges(repoPath);
  try {
    // Rebase re-commits every replayed commit under the CURRENT committer
    // identity — unlike a fast-forward, it always writes, so a repo/container
    // with no git identity configured hard-fails here ("Committer identity
    // unknown") without this fallback. This was the actual cause of the
    // reported Pull failure: attemptRebaseFallback (reconcile.ts) already
    // passed gitIdentityEnv to its own rebase; this call site — the one the
    // Settings → Versions Pull button and Push's non-fast-forward recovery
    // both go through — did not.
    const { stdout, stderr, exitCode } = await runGit(["rebase", `${remote}/${branch}`], { cwd: repoPath, env: await gitIdentityEnv(repoPath) });
    const durationMs = Date.now() - t0;

    if (exitCode !== 0) {
      // Always abort — a half-applied rebase must never be left in place,
      // whether this was a real conflict or some other failure.
      await runGit(["rebase", "--abort"], { cwd: repoPath }).catch(() => undefined);
      // Defensive belt-and-braces: `rebase --abort` can itself fail to fully
      // clean up (e.g. a corrupted rebase state) — remove the state dirs
      // directly so a stuck rebase never blocks the next operation.
      await fs.rm(path.join(repoPath, ".git", "rebase-merge"), { recursive: true, force: true }).catch(() => undefined);
      await fs.rm(path.join(repoPath, ".git", "rebase-apply"), { recursive: true, force: true }).catch(() => undefined);
      if (isMergeConflict(stderr) || isMergeConflict(stdout)) {
        gitLogger().warn({ op, repoPath, remote, durationMs, success: false, error: { code: "REBASE_CONFLICT", message: stderr || stdout } });
        return { status: "conflict" };
      }
      gitLogger().error({ op, repoPath, remote, durationMs, success: false, error: { code: "GIT_REBASE_FAILED", message: stderr || stdout } });
      throw makeError("GIT_REBASE_FAILED", stderr || stdout);
    }

    gitLogger().info({ op, repoPath, remote, durationMs, success: true });
    return { status: "success" };
  } finally {
    if (dirty) await popStash(repoPath);
  }
}

export async function switchBranch(
  repoPath: string,
  branch: string,
): Promise<void> {
  const op = "git.switchBranch";
  gitLogger().debug({ op, repoPath });
  const t0 = Date.now();

  const { stderr, exitCode } = await runGit(
    ["checkout", branch],
    { cwd: repoPath },
  );
  const durationMs = Date.now() - t0;

  if (exitCode !== 0) {
    gitLogger().error({ op, repoPath, durationMs, success: false, error: { code: "GIT_SWITCH_BRANCH_FAILED", message: stderr } });
    throw makeError("GIT_SWITCH_BRANCH_FAILED", stderr);
  }

  gitLogger().info({ op, repoPath, durationMs, success: true });
}

/** Create a new branch WITHOUT checking it out (unlike switchBranch, which
 *  checks out an EXISTING one). `from` defaults to the repo's current HEAD. */
export async function createBranch(repoPath: string, branch: string, from?: string): Promise<void> {
  const op = "git.createBranch";
  const args = from ? ["branch", branch, from] : ["branch", branch];
  const { stderr, exitCode } = await runGit(args, { cwd: repoPath });
  if (exitCode !== 0) {
    gitLogger().error({ op, repoPath, success: false, error: { code: "GIT_CREATE_BRANCH_FAILED", message: stderr } });
    throw makeError("GIT_CREATE_BRANCH_FAILED", stderr);
  }
  gitLogger().info({ op, repoPath, success: true });
}

/** Check out an EXISTING branch into a new linked worktree at `worktreePath`.
 *  The branch must not already be checked out in another worktree. */
export async function addWorktree(repoPath: string, worktreePath: string, branch: string): Promise<void> {
  const op = "git.addWorktree";
  const { stderr, exitCode } = await runGit(["worktree", "add", worktreePath, branch], { cwd: repoPath });
  if (exitCode !== 0) {
    gitLogger().error({ op, repoPath, success: false, error: { code: "GIT_ADD_WORKTREE_FAILED", message: `${worktreePath}: ${stderr}` } });
    throw makeError("GIT_ADD_WORKTREE_FAILED", stderr);
  }
  gitLogger().info({ op, repoPath, success: true });
}

/** Remove a linked worktree (deletes its directory and its registration in
 *  the main repo). `force` is required when the worktree has uncommitted
 *  changes or is otherwise "locked" by git's own safety check. */
export async function removeWorktree(repoPath: string, worktreePath: string, opts: { force?: boolean } = {}): Promise<void> {
  const op = "git.removeWorktree";
  const args = ["worktree", "remove", ...(opts.force ? ["--force"] : []), worktreePath];
  const { stderr, exitCode } = await runGit(args, { cwd: repoPath });
  if (exitCode !== 0) {
    gitLogger().error({ op, repoPath, success: false, error: { code: "GIT_REMOVE_WORKTREE_FAILED", message: `${worktreePath}: ${stderr}` } });
    throw makeError("GIT_REMOVE_WORKTREE_FAILED", stderr);
  }
  gitLogger().info({ op, repoPath, success: true });
}

/** Delete a branch. `force` (`-D`) is required for a branch not fully merged
 *  into HEAD, or one whose only worktree was just force-removed. */
export async function deleteBranch(repoPath: string, branch: string, opts: { force?: boolean } = {}): Promise<void> {
  const op = "git.deleteBranch";
  const { stderr, exitCode } = await runGit(["branch", opts.force ? "-D" : "-d", branch], { cwd: repoPath });
  if (exitCode !== 0) {
    gitLogger().error({ op, repoPath, success: false, error: { code: "GIT_DELETE_BRANCH_FAILED", message: stderr } });
    throw makeError("GIT_DELETE_BRANCH_FAILED", stderr);
  }
  gitLogger().info({ op, repoPath, success: true });
}

export async function stashChanges(repoPath: string): Promise<void> {
  const op = "git.stash";
  const { stderr, exitCode } = await runGit(
    ["stash", "push", "--include-untracked", "-m", "gitops-auto-stash"],
    { cwd: repoPath },
  );
  if (exitCode !== 0) {
    gitLogger().error({ op, repoPath, success: false, error: { code: "GIT_STASH_FAILED", message: stderr } });
    throw makeError("GIT_STASH_FAILED", stderr);
  }
  gitLogger().info({ op, repoPath, success: true });
}

export async function popStash(repoPath: string): Promise<void> {
  const op = "git.stashPop";
  const { stderr, exitCode } = await runGit(
    ["stash", "pop"],
    { cwd: repoPath },
  );
  if (exitCode !== 0) {
    // Don't throw on stash pop failure — stash is still saved.
    gitLogger().warn({ op, repoPath, error: { code: "GIT_STASH_POP_FAILED", message: stderr } });
    return;
  }
  gitLogger().info({ op, repoPath, success: true });
}

/**
 * A failed status read must never be silently treated as "clean" — this
 * gates whether callers stash before a destructive rebase/reset, so
 * misreading "unreadable" as "nothing to stash" risks losing uncommitted
 * work. Throws on a genuine read failure instead of returning `false`.
 */
export async function hasUncommittedChanges(repoPath: string): Promise<boolean> {
  const op = "git.hasUncommittedChanges";
  const { stdout, stderr, exitCode } = await runGit(
    ["status", "--porcelain"],
    { cwd: repoPath },
  );
  if (exitCode !== 0) {
    gitLogger().error({ op, repoPath, success: false, error: { code: "GIT_STATUS_FAILED", message: stderr } });
    throw makeError("GIT_STATUS_FAILED", stderr);
  }
  gitLogger().debug({ op, repoPath, success: true });
  return stdout.length > 0;
}

/**
 * Resolve `cwd` to the root of its MAIN working tree. Under the Supervisor
 * (live version control, specs/005), the process actually serving HTTP
 * requests runs `next start` from inside a LINKED, DETACHED-HEAD git worktree
 * (`bos-worktrees/base` or a candidate's own worktree) — `process.cwd()` there
 * is not the canonical checkout. A branch/remote operation (fetch, push,
 * fast-forward merge) run against a detached worktree only ever moves that
 * worktree's own throwaway commit pointer; it can never advance
 * `refs/heads/<branch>` in the shared repository, since detached HEAD isn't
 * "on" any branch. That silently no-ops branch pulls/pushes while still
 * reporting success (the git commands themselves genuinely succeed).
 *
 * `git rev-parse --git-common-dir` always resolves to the ONE shared `.git`
 * directory, regardless of which linked worktree `cwd` is in (in the main
 * worktree itself, `--git-common-dir` and `--git-dir` are the same path, so
 * this is a no-op there) — its parent directory is always the true
 * main-worktree root. Falls back to `cwd` itself on any failure (bare repo,
 * not a git repo, git not on PATH, etc.) so callers can treat this as a
 * best-effort upgrade, never a hard requirement.
 */
export async function resolveMainWorktreeRoot(cwd: string): Promise<string> {
  try {
    const { stdout, exitCode } = await runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
    if (exitCode !== 0 || !stdout) return cwd;
    const gitDir = path.resolve(stdout);
    const parent = path.dirname(gitDir);
    return path.basename(gitDir) === ".git" ? parent : cwd;
  } catch {
    return cwd;
  }
}

export async function hasGitDir(repoPath: string): Promise<boolean> {
  const op = "git.hasGitDir";
  try {
    await fs.access(path.join(repoPath, ".git"));
    gitLogger().debug({ op, repoPath, success: true });
    return true;
  } catch {
    gitLogger().debug({ op, repoPath, success: false });
    return false;
  }
}

export function getBareCachePath(url: string): string {
  // Create a deterministic path from the URL using a simple hash.
  const sanitized = url.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 128);
  const hash = randomBytes(8).toString("hex");
  return path.join("data", ".git-cache", `${sanitized}.${hash}.git`);
}

export async function updateBareCache(
  url: string,
  branch: string,
  auth?: GitAuth,
): Promise<void> {
  const op = "git.updateBareCache";
  const cachePath = getBareCachePath(url);

  try {
    await fs.access(cachePath);
  } catch {
    // Bare cache doesn't exist — create it. Auth flows through the credential
    // helper (runGit), so the URL stays plain.
    await runGit(["clone", "--bare", url, cachePath], { auth });
  }

  // Fetch latest — checked, not fire-and-forget: a failed fetch here left
  // the bare cache silently stale while this function still reported success.
  const { stderr, exitCode } = await runGit(["fetch", "origin", branch], { cwd: cachePath, auth });
  if (exitCode !== 0) {
    gitLogger().error({ op, repoPath: cachePath, remote: url, success: false, error: { code: "GIT_FETCH_FAILED", message: stderr } });
    throw makeError("GIT_FETCH_FAILED", stderr);
  }
  gitLogger().debug({ op, repoPath: cachePath, remote: url, success: true });
}

export async function scanSymlinkEscapes(dirPath: string): Promise<string[]> {
  const escapes: string[] = [];
  const resolvedRoot = path.resolve(dirPath);

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          const target = await fs.readlink(fullPath);
          const resolvedTarget = path.resolve(dir, target);
          if (!resolvedTarget.startsWith(resolvedRoot)) {
            escapes.push(fullPath);
          }
        } catch {
          // ignore unreadable symlinks
        }
      } else if (entry.isDirectory()) {
        if (entry.name === ".git") continue;
        await walk(fullPath);
      }
    }
  }

  await walk(resolvedRoot);
  return escapes;
}
