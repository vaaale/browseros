import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { commitAll, commitScoped, ownsRepo } from "@/lib/gitfs/store";
import { logger } from "@/lib/logging/server-logger";
import { getGitIdentity } from "@/lib/config/store";

// Per-store git operations for spec versioning (018-external-spec-store,
// reworked by 020-branch-coupled-specs). Direct edits commit-on-save to the
// store's default branch. In-progress feature work lives on `bos/*` DRAFT
// branches — created by the Supervisor as store worktrees coupled to the code's
// feature branch — which this module reads (list/diff/show) WITHOUT checking
// anything out, so base can render drafts from any branch. Promote/discard of
// draft branches is the Supervisor's job (coupled to the code promote); the old
// global `spec-candidate` branch is retired.

const exec = promisify(execFile);
const DRAFT_BRANCH = /^bos\/[a-z0-9/-]+$/;

// A local identity so commits never fail on a machine with no global git
// config. Sourced from Settings → Versions (defaults to "BrowserOS" <bos@localhost>).
async function identityArgs(): Promise<string[]> {
  const { name, email } = await getGitIdentity();
  return ["-c", `user.name=${name}`, "-c", `user.email=${email}`];
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", [...(await identityArgs()), ...args], {
    cwd: root,
    timeout: 20_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

function requireDraftBranch(branch: string): string {
  if (!DRAFT_BRANCH.test(branch)) throw new Error(`Not a draft branch: "${branch}" (expected bos/<name>).`);
  return branch;
}

/** The store's default branch = its canonical checkout (drafts live in worktrees). */
async function defaultBranch(root: string): Promise<string> {
  try {
    return await git(root, ["symbolic-ref", "--short", "HEAD"]);
  } catch {
    return "master";
  }
}

/** Commit-on-save for direct (base-side) edits — all writable stores. An
 *  item-owned store's root is a subdirectory of an already-initialized repo
 *  (the item's `spec/` folder inside `user-apps`), not a repo root itself —
 *  route those through `commitScoped` so the save is pathspec-jailed to the
 *  item and never `git init`s a stray nested repo or sweeps in a sibling
 *  item's unrelated changes. */
export async function commitOnSave(root: string, message: string): Promise<void> {
  if (await ownsRepo(root)) {
    await commitAll(root, message);
  } else {
    await commitScoped(root, message);
  }
}

/** Draft branches (`bos/*`) whose tree differs from the store's default branch. */
export async function listDraftBranches(root: string): Promise<string[]> {
  let out = "";
  try {
    out = await git(root, ["branch", "--list", "bos/*", "--format=%(refname:short)"]);
  } catch (e) {
    logger().warn("specs.store-git", `failed to list draft branches in ${root}`, { error: (e as Error).message });
    return [];
  }
  const base = await defaultBranch(root);
  const drafts: string[] = [];
  for (const b of out.split("\n").map((s) => s.trim()).filter(Boolean)) {
    if (!DRAFT_BRANCH.test(b)) continue;
    // A real `diff` failure must not be treated the same as "no changes" —
    // that silently hides an existing draft branch from the list, making it
    // look like the work was never done. Only an actually-empty diff means
    // "no changes"; a failed command still counts the branch as a draft.
    try {
      const diff = await git(root, ["diff", "--name-only", `${base}...${b}`]);
      if (diff) drafts.push(b);
    } catch (e) {
      logger().warn("specs.store-git", `failed to diff draft branch ${b} against ${base} in ${root}`, { error: (e as Error).message });
      drafts.push(b);
    }
  }
  return drafts;
}

/** Files changed on a draft branch since it diverged from the default branch. */
export async function draftChangedFiles(root: string, branch: string): Promise<string[]> {
  requireDraftBranch(branch);
  const base = await defaultBranch(root);
  const out = await git(root, ["diff", "--name-only", `${base}...${branch}`]).catch(() => "");
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** All files under a directory as they exist ON a draft branch — a full listing
 *  (not a diff), so the tree matches the branch/worktree including artifacts that
 *  are unchanged since the fork point. `dir` is store-relative (e.g. a feature id). */
export async function listBranchDirFiles(root: string, branch: string, dir: string): Promise<string[]> {
  requireDraftBranch(branch);
  const clean = dir.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!clean || clean.split("/").some((seg) => seg === ".." || seg.startsWith("-"))) return [];
  const out = await git(root, ["ls-tree", "-r", "--name-only", branch, "--", `${clean}/`]).catch(() => "");
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** Every file in the WHOLE store as it exists on a draft branch — no `dir`
 *  filter. Used to find feature leaves (dirs directly containing spec.md) at
 *  any depth under a project (033), since a changed file's nearest ancestor
 *  leaf can't be assumed to be its first path segment anymore. */
export async function listAllBranchFiles(root: string, branch: string): Promise<string[]> {
  requireDraftBranch(branch);
  const out = await git(root, ["ls-tree", "-r", "--name-only", branch]).catch(() => "");
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** Read a file's content at a draft branch (no checkout). `rel` must already be
 *  store-jailed by the caller (spec-fs). */
export async function readFileAtBranch(root: string, branch: string, rel: string): Promise<string> {
  requireDraftBranch(branch);
  return readFileAtRef(root, branch, rel);
}

/** Read a file's content at ANY historical ref (a commit sha, tag, or branch
 *  of any kind — not just a `bos/*` draft branch) — no checkout. Used for
 *  history browsing (037-project-layer): a store is one on-disk repo, so
 *  `git show` can read any commit in its object DB regardless of which
 *  branch (if any) currently points at it. `rel` must already be
 *  store-jailed by the caller (spec-fs). */
export async function readFileAtRef(root: string, ref: string, rel: string): Promise<string> {
  const norm = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!norm || norm.split("/").some((seg) => seg === ".." || seg.startsWith("-"))) {
    throw new Error(`Invalid path for ref read: "${rel}"`);
  }
  if (/^-/.test(ref)) throw new Error(`Invalid ref: "${ref}"`);
  return git(root, ["show", `${ref}:${norm}`]);
}
