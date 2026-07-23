import "server-only";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { gitLogger } from "./logging";
import type { GitAuth } from "./auth";
import { buildCredentialConfig } from "./git-credential-helper";

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
      env: { ...process.env, ...authEnv(opts.auth), ...cred.env },
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

function makeError(code: string, message: string, suggestion?: string): GitError {
  return { code, message, suggestion };
}

function parseAheadBehind(output: string): AheadBehind {
  // git rev-list --left-right --count origin/main...HEAD outputs: "ahead\tbehind"
  const parts = output.split("\t");
  return {
    ahead: parseInt(parts[0] ?? "0", 10) || 0,
    behind: parseInt(parts[1] ?? "0", 10) || 0,
  };
}

function isAuthFailure(stderr: string): boolean {
  return (
    /authentication/i.test(stderr) ||
    /Permission denied/i.test(stderr) ||
    /fatal: .*(?:token|credential)/i.test(stderr) ||
    /401/.test(stderr) ||
    /403/.test(stderr)
  );
}

function isMergeConflict(stderr: string): boolean {
  return /CONFLICT/i.test(stderr) || /merge failed/i.test(stderr);
}

// ── Operations ───────────────────────────────────────────────────────────────

export async function cloneRepo(
  url: string,
  targetPath: string,
  branch?: string,
  auth?: GitAuth,
): Promise<void> {
  const op = "git.clone";
  const authedUrl = auth?.accessToken
    ? applyTokenToUrl(url, auth.accessToken)
    : auth?.pat
      ? applyTokenToUrl(url, auth.pat)
      : url;

  const args = ["clone", authedUrl, targetPath];
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

  // Compute ahead/behind against the remote.
  const target = remote ?? "origin";
  const branchArg = branch ?? await getCurrentBranch(repoPath);
  const ab = await runGit(
    ["rev-list", "--left-right", "--count", `${target}/${branchArg}...HEAD`],
    { cwd: repoPath, auth },
  );
  const result = ab.exitCode === 0 ? parseAheadBehind(ab.stdout) : { ahead: 0, behind: 0 };

  gitLogger().info({ op, repoPath, remote: target, durationMs, success: true });
  return result;
}

export async function pushRepo(
  repoPath: string,
  remote: string,
  branch: string,
  auth?: GitAuth,
): Promise<void> {
  const op = "git.push";
  const args = ["push", remote, branch];

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
  const authedUrl = auth?.accessToken
    ? applyTokenToUrl(url, auth.accessToken)
    : auth?.pat
      ? applyTokenToUrl(url, auth.pat)
      : url;

  gitLogger().debug({ op, remote: url });
  const t0 = Date.now();

  const { stdout, stderr, exitCode } = await runGit(
    ["ls-remote", "--heads", authedUrl],
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
  const authedUrl = auth?.accessToken
    ? applyTokenToUrl(url, auth.accessToken)
    : auth?.pat
      ? applyTokenToUrl(url, auth.pat)
      : url;

  gitLogger().debug({ op, remote: url });
  const t0 = Date.now();

  const { stdout, stderr, exitCode } = await runGit(
    ["ls-remote", "--symref", authedUrl, "HEAD"],
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
  if (exitCode !== 0) throw makeError("GIT_CURRENT_BRANCH_FAILED", "Could not determine current branch");
  return stdout;
}

export async function testConnection(
  url: string,
  auth?: GitAuth,
): Promise<TestConnectionResult> {
  const op = "git.testConnection";
  const authedUrl = auth?.accessToken
    ? applyTokenToUrl(url, auth.accessToken)
    : auth?.pat
      ? applyTokenToUrl(url, auth.pat)
      : url;

  gitLogger().debug({ op, remote: url });
  const t0 = Date.now();

  try {
    const branches = await listRemoteBranches(authedUrl, auth);
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
        gitLogger().error({ op, repoPath, remote, durationMs, success: false, error: { code: "MERGE_CONFLICT", message: mergeErr } });
        throw makeError("MERGE_CONFLICT", mergeErr, "Resolve manually or try a different strategy.");
      }
      await runGit(
        ["commit", "-m", `Fetch remote changes from ${remote}/${branch}`],
        { cwd: repoPath },
      );
    } finally {
      await popStash(repoPath);
    }
  } else {
    const args = strategy === "merge-squash"
      ? ["merge", "--squash", `${remote}/${branch}`]
      : ["merge", `${remote}/${branch}`];

    const { stderr, exitCode } = await runGit(args, { cwd: repoPath });
    const durationMs = Date.now() - t0;

    if (exitCode !== 0 && isMergeConflict(stderr)) {
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

export async function stashChanges(repoPath: string): Promise<void> {
  const op = "git.stash";
  const { stderr, exitCode } = await runGit(
    ["stash", "push", "--include-untracked", "-m", "gitops-auto-stash"],
    { cwd: repoPath },
  );
  if (exitCode !== 0) {
    throw makeError("GIT_STASH_FAILED", stderr);
  }
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
  }
}

export async function hasUncommittedChanges(repoPath: string): Promise<boolean> {
  const { stdout, exitCode } = await runGit(
    ["status", "--porcelain"],
    { cwd: repoPath },
  );
  if (exitCode !== 0) return false;
  return stdout.length > 0;
}

export async function hasGitDir(repoPath: string): Promise<boolean> {
  try {
    await fs.access(path.join(repoPath, ".git"));
    return true;
  } catch {
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
    // Bare cache doesn't exist — create it.
    const authedUrl = auth?.accessToken
      ? applyTokenToUrl(url, auth.accessToken)
      : auth?.pat
        ? applyTokenToUrl(url, auth.pat)
        : url;

    await runGit(["clone", "--bare", authedUrl, cachePath], { auth });
  }

  // Fetch latest.
  const authedUrl = auth?.accessToken
    ? applyTokenToUrl(url, auth.accessToken)
    : auth?.pat
      ? applyTokenToUrl(url, auth.pat)
      : url;

  await runGit(["fetch", "origin", branch], { cwd: cachePath, auth });
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

// ── URL Helpers ──────────────────────────────────────────────────────────────

function applyTokenToUrl(url: string, token: string): string {
  return url.replace(/^(https?:\/\/)/, `$1oauth2:${token}@`);
}
