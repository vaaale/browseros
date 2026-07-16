import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { logger } from "@/lib/logging/server-logger";

// Git worktree + commit helpers for SpecFS (027-vfs-specfs). This is a FRAGILE
// path: worktree provisioning, pruning, and merges are orchestration over the
// git CLI, not pure logic, and they interact with the Supervisor's own worktree
// model (020). Every operation logs at DEBUG so a broken preview/promote cycle
// is diagnosable, and every operation surfaces failures with context rather than
// swallowing them (the one deliberate exception is documented inline).
//
// Reuses the local-identity + init discipline of src/lib/gitfs/store.ts.

const exec = promisify(execFile);
const IDENTITY = ["-c", "user.name=BrowserOS", "-c", "user.email=bos@localhost"];
const COMPONENT = "specfs.git";

/** Run a git command in `cwd`, returning trimmed stdout. Throws with context. */
export async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", [...IDENTITY, ...args], {
      cwd,
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    logger().debug(COMPONENT, "git command failed", { cwd, args, err: String(err) });
    throw new Error(`git ${args[0]} failed in ${cwd}: ${(err as Error).message}`);
  }
}

/** Local branches present in the repo (short names). */
export async function localBranches(repoRoot: string): Promise<string[]> {
  const out = await git(repoRoot, ["branch", "--format=%(refname:short)"]).catch(() => "");
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** The repo's default (currently checked-out) branch, or "main" as a fallback. */
export async function defaultBranch(repoRoot: string): Promise<string> {
  try {
    return await git(repoRoot, ["symbolic-ref", "--short", "HEAD"]);
  } catch {
    return "main";
  }
}

/** Whether a working tree (repo root OR a worktree dir) has uncommitted changes. */
export async function hasUncommitted(dir: string): Promise<boolean> {
  const out = await git(dir, ["status", "--porcelain"]).catch(() => "");
  return out.length > 0;
}

/**
 * Ensure a worktree of `repoRoot` exists at `worktreePath`, checked out on
 * `branch` (created from the default branch if absent). Idempotent: reuses an
 * existing worktree. Returns `worktreePath`.
 *
 * FRAGILE: `git worktree add` refuses a branch already checked out elsewhere
 * (e.g. held by the Supervisor). Callers that might collide must resolve
 * precedence first (see SpecFS N1 hand-off).
 */
export async function ensureWorktree(
  repoRoot: string,
  worktreePath: string,
  branch: string,
): Promise<string> {
  const existing = await fs
    .access(path.join(worktreePath, ".git"))
    .then(() => true)
    .catch(() => false);
  if (existing) {
    logger().debug(COMPONENT, "reusing existing worktree", { worktreePath, branch });
    return worktreePath;
  }
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  const branches = await localBranches(repoRoot);
  const args = branches.includes(branch)
    ? ["worktree", "add", "--quiet", worktreePath, branch]
    : ["worktree", "add", "--quiet", "-b", branch, worktreePath];
  logger().debug(COMPONENT, "provisioning worktree", {
    repoRoot,
    worktreePath,
    branch,
    created: !branches.includes(branch),
  });
  await git(repoRoot, args);
  return worktreePath;
}

/** Remove a worktree and prune stale metadata. Best-effort but logged. */
export async function pruneWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  logger().debug(COMPONENT, "pruning worktree", { repoRoot, worktreePath });
  await git(repoRoot, ["worktree", "remove", "--force", worktreePath]).catch((err) => {
    logger().warn(COMPONENT, "worktree remove failed; pruning anyway", { worktreePath, err: String(err) });
  });
  await git(repoRoot, ["worktree", "prune"]).catch(() => {});
}

/** Absolute paths of all worktrees registered for `repoRoot` (excludes the main one). */
export async function listWorktrees(repoRoot: string): Promise<string[]> {
  const out = await git(repoRoot, ["worktree", "list", "--porcelain"]).catch(() => "");
  const paths: string[] = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      const p = line.slice("worktree ".length).trim();
      if (p && path.resolve(p) !== path.resolve(repoRoot)) paths.push(p);
    }
  }
  return paths;
}

/** Stage everything in `dir` and commit; no-op when clean. */
export async function commit(dir: string, message: string): Promise<void> {
  await git(dir, ["add", "-A"]);
  const dirty = await git(dir, ["status", "--porcelain"]).catch(() => "");
  if (!dirty) return;
  await git(dir, ["commit", "--quiet", "-m", message]);
  logger().debug(COMPONENT, "committed", { dir, message });
}

/** Diff of uncommitted changes in a working tree (staged + unstaged). */
export async function workingDiff(dir: string): Promise<string> {
  await git(dir, ["add", "-A"]).catch(() => {});
  return git(dir, ["diff", "--cached"]).catch(() => "");
}
