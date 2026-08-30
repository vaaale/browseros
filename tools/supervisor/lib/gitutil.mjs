import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { REPO, FEATURE_BRANCH_PREFIX, FEATURE_BRANCH_SLUG } from "./config.mjs";
import { slog } from "./log.mjs";

const exec = promisify(execFile);

export async function git(args, cwd = REPO, env) {
  const { stdout } = await exec("git", args, {
    cwd,
    maxBuffer: 8 * 1024 * 1024,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  return stdout.trim();
}

/**
 * Genuine existence probe (e.g. "does refs/heads/<branch> already exist" to
 * decide reuse-vs-create). Resolves `false` ONLY for the specific "not found"
 * condition; a real git failure (corrupt repo, not a git dir, permissions)
 * still throws — a failed read must never be silently read as "doesn't
 * exist". Replaces every prior `gitTry(["rev-parse","--verify",...], ignoreGitError)`
 * probe call site.
 */
export async function refExists(cwd, ref) {
  try {
    await git(["rev-parse", "--verify", ref], cwd);
    return true;
  } catch (e) {
    const msg = e?.message || String(e);
    if (/needed a single revision|unknown revision|bad revision/i.test(msg)) return false;
    throw e;
  }
}

/**
 * A mutation allowed to fail without aborting the whole operation — but the
 * failure is ALWAYS recorded, never just logged and dropped. `warnings` (an
 * array threaded from the caller all the way to its HTTP response) receives
 * one entry per failure, so a partial-failure result is visible to the UI
 * instead of masquerading as full success. Replaces every prior
 * `gitTry(args, ignoreGitError, cwd)` call site that performs a real mutation
 * (branch delete, worktree remove, checkout, reset, clean, merge --abort, …).
 */
export async function mutate(label, fn, warnings) {
  try {
    return await fn();
  } catch (e) {
    const msg = `${label} failed: ${e?.message || e}`;
    slog("warn", "mutate", msg);
    if (Array.isArray(warnings)) warnings.push(msg);
    return undefined;
  }
}

export const GIT_IDENTITY = ["-c", "user.name=BrowserOS", "-c", "user.email=bos@localhost"];

export function isFeatureBranch(branch, baseBranch) {
  if (typeof branch !== "string" || !branch.startsWith(FEATURE_BRANCH_PREFIX) || branch === baseBranch) return false;
  return FEATURE_BRANCH_SLUG.test(branch.slice(FEATURE_BRANCH_PREFIX.length));
}

export function requireFeatureBranch(branch, baseBranch) {
  if (!isFeatureBranch(branch, baseBranch)) {
    throw new Error(`feature branch must match ${FEATURE_BRANCH_PREFIX}<kebab-name> with 1-4 lowercase dash-separated segments`);
  }
  return branch;
}

export function tagStamp() {
  const d = new Date();
  const z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}-${z(d.getHours())}_${z(d.getMinutes())}_${z(d.getSeconds())}`;
}

// npm install (run on every container start by docker-entrypoint.sh, and again
// after a promote whose deps changed) can legitimately touch package-lock.json
// — platform-specific optional-dependency entries differ by OS/arch, and npm
// may reformat it. That is expected provisioning behavior, not an agent
// editing the live checkout, so it alone must never count as "dirty" for any
// safety/pre-flight check. Shared by assertRepoIntegrity (post-condition gate)
// and promote (pre-flight gate) so both treat lockfile-only drift identically.
export function meaningfulDirtyLines(dirty) {
  return (dirty || "")
    .split("\n")
    .filter((line) => line.trim() && !line.trim().endsWith("package-lock.json"));
}
