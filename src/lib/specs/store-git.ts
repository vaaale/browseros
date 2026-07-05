import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { commitAll } from "@/lib/gitfs/store";

// Per-store git operations for spec versioning (018-external-spec-store,
// reworked by 020-branch-coupled-specs). Direct edits commit-on-save to the
// store's default branch. In-progress feature work lives on `bos/*` DRAFT
// branches — created by the Supervisor as store worktrees coupled to the code's
// feature branch — which this module reads (list/diff/show) WITHOUT checking
// anything out, so base can render drafts from any branch. Promote/discard of
// draft branches is the Supervisor's job (coupled to the code promote); the old
// global `spec-candidate` branch is retired.

const exec = promisify(execFile);
const IDENTITY = ["-c", "user.name=BrowserOS", "-c", "user.email=bos@localhost"];
const DRAFT_BRANCH = /^bos\/[a-z0-9/-]+$/;

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", [...IDENTITY, ...args], {
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

/** Commit-on-save for direct (base-side) edits — all writable stores. */
export async function commitOnSave(root: string, message: string): Promise<void> {
  await commitAll(root, message);
}

/** Draft branches (`bos/*`) whose tree differs from the store's default branch. */
export async function listDraftBranches(root: string): Promise<string[]> {
  let out = "";
  try {
    out = await git(root, ["branch", "--list", "bos/*", "--format=%(refname:short)"]);
  } catch {
    return [];
  }
  const base = await defaultBranch(root);
  const drafts: string[] = [];
  for (const b of out.split("\n").map((s) => s.trim()).filter(Boolean)) {
    if (!DRAFT_BRANCH.test(b)) continue;
    const diff = await git(root, ["diff", "--name-only", `${base}...${b}`]).catch(() => "");
    if (diff) drafts.push(b);
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

/** Read a file's content at a draft branch (no checkout). `rel` must already be
 *  store-jailed by the caller (spec-fs). */
export async function readFileAtBranch(root: string, branch: string, rel: string): Promise<string> {
  requireDraftBranch(branch);
  const norm = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!norm || norm.split("/").some((seg) => seg === ".." || seg.startsWith("-"))) {
    throw new Error(`Invalid path for branch read: "${rel}"`);
  }
  return git(root, ["show", `${branch}:${norm}`]);
}
