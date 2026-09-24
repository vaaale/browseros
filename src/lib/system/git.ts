import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

// Scoped, non-destructive git helper. Read-only status is always allowed; the
// MUTATING operations (branch checkout, staging) are refused under the Supervisor:
// there, the live checkout (this process's cwd) is the BASE the OS serves, and the
// Supervisor — not the assistant — owns version branches. Source changes happen in
// an isolated preview worktree via the developer sub-agent, never in this checkout.
// Switching/branching/staging here would corrupt the running base and block promote
// (specs/005, 017 diagnosis). Outside the Supervisor (plain `npm run dev`) the
// in-place behavior is preserved.
const exec = promisify(execFile);
const REPO = process.cwd();

// True when this BOS process runs under the Supervisor (live version control).
function supervised(): boolean {
  return !!(process.env.BOS_SUPERVISOR_URL || "").trim();
}

const SUPERVISOR_OWNS_GIT =
  "Refusing to modify the live checkout: the Supervisor owns version branches and " +
  "the developer sub-agent makes source changes in an isolated preview worktree. " +
  "Do not branch or stage the main checkout (it is the running base) — delegate the " +
  "change to the developer instead.";

async function git(args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd: REPO, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

export async function currentBranch(): Promise<string> {
  return git(["rev-parse", "--abbrev-ref", "HEAD"]);
}

export async function status(): Promise<{ branch: string; files: { status: string; path: string }[] }> {
  const branch = await currentBranch();
  const out = await git(["status", "--porcelain"]);
  const files = out
    ? out.split("\n").map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3) }))
    : [];
  return { branch, files };
}

async function remoteNames(): Promise<string[]> {
  const out = await git(["remote"]).catch(() => "");
  return out ? out.split("\n").map((l) => l.trim()).filter(Boolean) : [];
}

/** Every remote's fetched `<remote>/bos/*` tracking ref, as `<remote>/bos/<slug>`
 *  (`for-each-ref`'s glob doesn't expand a bare `*` remote-name segment the way
 *  a fixed prefix does, so remotes are queried one at a time instead). */
async function remoteFeatureBranchRefs(): Promise<string[]> {
  const refs: string[] = [];
  for (const remote of await remoteNames()) {
    const out = await git(["for-each-ref", "--format=%(refname:short)", `refs/remotes/${remote}/bos`]).catch(() => "");
    if (out) refs.push(...out.split("\n").map((l) => l.trim()).filter(Boolean));
  }
  return refs;
}

/** List existing `bos/*` feature branches — local refs (read-only, allowed
 *  under the Supervisor since the worktrees share one `.git`) PLUS every
 *  remote's already-fetched tracking refs, so a branch created elsewhere
 *  (another checkout, another contributor, a fresh clone of this repo) and
 *  pushed shows up here too, not just ones already checked out locally.
 *  Used to offer resumable branches in the Assistant. */
export async function listFeatureBranches(): Promise<string[]> {
  try {
    const local = await git(["for-each-ref", "--format=%(refname:short)", "refs/heads/bos"]);
    const localNames = local ? local.split("\n").map((l) => l.trim()).filter(Boolean) : [];
    // A remote-tracking short name is "<remote>/bos/<slug>" — strip the
    // leading remote-name segment to get the bare "bos/<slug>" branch name.
    const remoteAsLocalNames = (await remoteFeatureBranchRefs()).map((r) => r.split("/").slice(1).join("/"));
    return Array.from(new Set([...localNames, ...remoteAsLocalNames])).sort();
  } catch {
    return [];
  }
}

function featureBranchName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9/_-]+/g, "-").replace(/^-+|-+$/g, "") || "change";
  return slug.startsWith("bos/") ? slug : `bos/${slug}`;
}

/** Create (or resume) a `bos/<name>` feature branch. Refused under the
 *  Supervisor — switching the live checkout's branch breaks the running base.
 *  Resuming prefers, in order: an existing LOCAL branch of that name; a
 *  remote's fetched tracking ref of that name (checked out with `--track`,
 *  so it starts from the remote's actual history instead of silently
 *  diverging from a fresh branch off current HEAD — `origin` is preferred
 *  when more than one remote has it); otherwise a genuinely new branch. */
export async function createFeatureBranch(name: string): Promise<string> {
  if (supervised()) throw new Error(SUPERVISOR_OWNS_GIT);
  const branch = featureBranchName(name);
  // Only the existence probe is allowed to fail silently (a missing branch
  // is the expected, common case) — the checkout itself is NOT inside this
  // try/catch, so a real checkout failure on an EXISTING branch surfaces as
  // its own error instead of being masked and retried as "create", which
  // then failed with a confusing "already exists" instead of the true cause.
  let exists = true;
  try {
    await git(["rev-parse", "--verify", branch]);
  } catch {
    exists = false;
  }
  if (exists) {
    await git(["checkout", branch]);
    return branch;
  }
  const remoteRefs = (await remoteFeatureBranchRefs()).filter((r) => r.split("/").slice(1).join("/") === branch);
  const remoteRef = remoteRefs.find((r) => r.startsWith("origin/")) ?? remoteRefs[0];
  if (remoteRef) await git(["checkout", "-b", branch, "--track", remoteRef]);
  else await git(["checkout", "-b", branch]);
  return branch;
}

/** Stage specific files (git add). Paths are validated to stay inside the repo.
 *  Refused under the Supervisor — staging the live checkout's index is not the
 *  self-modification path (edits live on a preview worktree). */
export async function stageFiles(paths: string[]): Promise<number> {
  if (supervised()) throw new Error(SUPERVISOR_OWNS_GIT);
  const safe = paths
    .map((p) => p.replace(/^\/+/, "").trim())
    .filter((p) => p && !p.includes("..") && !p.startsWith("-"));
  if (safe.length === 0) return 0;
  await git(["add", "--", ...safe]);
  return safe.length;
}

export interface StageResult {
  /** Total files staged in the index after the operation. */
  staged: number;
  /** How many of those are newly-added (previously untracked) files. */
  created: number;
}

/**
 * Stage ALL changes — new, modified, and deleted — in the working tree. This is
 * the deterministic backstop the dev harness runs after a task so files the
 * agent *created* are never left untracked (the recurring "new file not added"
 * bug). Safe because dev work happens on a feature branch and `.gitignore`
 * excludes secrets, runtime data (`data/`), and build output. `cwd` defaults to
 * the repo root; pass a worktree path to stage there.
 */
export async function stageAll(cwd: string = REPO): Promise<StageResult> {
  // Never stage the LIVE checkout under the Supervisor: a dev run's edits belong to
  // an isolated worktree (passed as `cwd`); the Supervisor commits there. Touching
  // the base checkout's index would pollute the running version.
  if (supervised() && path.resolve(cwd) === path.resolve(REPO)) return { staged: 0, created: 0 };
  await exec("git", ["add", "-A"], { cwd, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
  const { stdout } = await exec("git", ["status", "--porcelain"], { cwd, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
  const lines = stdout.trim() ? stdout.trim().split("\n") : [];
  let staged = 0;
  let created = 0;
  for (const line of lines) {
    const index = line[0]; // the staged (index) status column
    if (index && index !== " " && index !== "?") {
      staged++;
      if (index === "A") created++;
    }
  }
  return { staged, created };
}

/** Head SHA of a local branch, or undefined when the ref does not exist.
 *  Read-only, so allowed under the Supervisor (the worktrees share one `.git`).
 *  Used to stamp `fixCommit` on a self-heal case at completeFix time (031
 *  FR-038). */
export async function branchHeadSha(branch: string): Promise<string | undefined> {
  try {
    return await git(["rev-parse", "--verify", `refs/heads/${branch}`]);
  } catch {
    return undefined;
  }
}

/** True when `sha` is an ancestor of `ref` (`git merge-base --is-ancestor`).
 *  Read-only. False covers both "not an ancestor" and "unknown sha/ref" — the
 *  callers (031 FR-038's boot reconcile) treat those the same: not provably
 *  merged. */
export async function isAncestorOf(sha: string, ref: string): Promise<boolean> {
  try {
    await git(["merge-base", "--is-ancestor", sha, ref]);
    return true;
  } catch {
    return false;
  }
}

/** A branch this API is allowed to delete: `bos/<kebab>` and nothing else — no
 *  extra path segments, no `..`, no leading dash. Deliberately broader than
 *  FEATURE_BRANCH_RE (which caps at four segments) so a longer, legitimately
 *  created feature branch is still removable, and deliberately exact-match so
 *  a caller's name is never silently normalized onto a DIFFERENT branch. */
const DELETABLE_BRANCH_RE = /^bos\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Delete a local `bos/*` feature branch. Allowed under the Supervisor — unlike
 * checkout/staging this never touches the live checkout's HEAD or index, and it
 * is the only way to clean up the branches the Supervisor itself creates at
 * delegate time (e2e runs otherwise leave a growing pile of real refs).
 *
 * Force-deletes (`-D`): feature branches are unmerged by definition. Refuses
 * the current branch, and git itself refuses a branch checked out in any
 * worktree — that error surfaces to the caller rather than being swallowed.
 * Remote refs are left alone. Missing branch is a no-op (`existed: false`), so
 * cleanup callers can delete the same name twice without special-casing.
 */
export async function deleteFeatureBranch(name: string): Promise<{ branch: string; existed: boolean }> {
  const branch = name.trim();
  if (!DELETABLE_BRANCH_RE.test(branch)) {
    throw new Error(`Invalid branch name "${name}": only "bos/<kebab-name>" branches can be deleted.`);
  }
  if (branch === (await currentBranch())) {
    throw new Error(`Refusing to delete "${branch}": it is the currently checked-out branch.`);
  }
  let existed = true;
  try {
    await git(["rev-parse", "--verify", `refs/heads/${branch}`]);
  } catch {
    existed = false;
  }
  if (existed) await git(["branch", "-D", branch]);
  return { branch, existed };
}
