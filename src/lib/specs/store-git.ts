import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureRepo, commitAll } from "@/lib/gitfs/store";

// Per-store git operations for spec versioning (018-external-spec-store). Specs
// are inert content, so promote is a build-free `git merge` in the store's own
// repo (mirrors the app-candidate model) — the Supervisor is NOT involved (no
// build, no preview server, no port). User stores commit-on-save; system stores
// accumulate on a candidate branch and promote/discard.

const exec = promisify(execFile);
const IDENTITY = ["-c", "user.name=BrowserOS", "-c", "user.email=bos@localhost"];
const CANDIDATE = "spec-candidate";

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", [...IDENTITY, ...args], {
    cwd: root,
    timeout: 20_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

async function currentBranch(root: string): Promise<string> {
  return git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

async function branchExists(root: string, branch: string): Promise<boolean> {
  try {
    await git(root, ["rev-parse", "--verify", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** The store's non-candidate default branch (main/master, whichever git init made). */
async function defaultBranch(root: string): Promise<string> {
  const out = await git(root, ["branch", "--format=%(refname:short)"]).catch(() => "");
  const branches = out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((b) => b !== CANDIDATE);
  if (branches.includes("main")) return "main";
  if (branches.includes("master")) return "master";
  return branches[0] || "master";
}

/** Commit-on-save for a writable, no-promote store (e.g. the user store). */
export async function commitOnSave(root: string, message: string): Promise<void> {
  await commitAll(root, message);
}

/** Ensure the store is on its candidate branch (created off the current default
 *  branch if absent) so in-place edits accumulate there for review. */
export async function beginCandidate(root: string): Promise<string> {
  await ensureRepo(root);
  if ((await currentBranch(root)) === CANDIDATE) return CANDIDATE;
  if (await branchExists(root, CANDIDATE)) await git(root, ["checkout", CANDIDATE]);
  else await git(root, ["checkout", "-b", CANDIDATE]);
  return CANDIDATE;
}

/** Whether the store currently has an in-progress candidate. */
export async function hasCandidate(root: string): Promise<boolean> {
  return branchExists(root, CANDIDATE);
}

/** Promote: commit pending edits, merge the candidate into the default branch
 *  (build-free), delete the candidate. */
export async function promoteCandidate(root: string): Promise<{ promoted: boolean }> {
  await commitAll(root, "spec changes");
  if (!(await branchExists(root, CANDIDATE))) return { promoted: false };
  const base = await defaultBranch(root);
  await git(root, ["checkout", base]);
  await git(root, ["merge", "--no-edit", CANDIDATE]);
  await git(root, ["branch", "-D", CANDIDATE]).catch(() => {});
  return { promoted: true };
}

/** Discard: return to the default branch and drop the candidate (losing its edits). */
export async function discardCandidate(root: string): Promise<{ discarded: boolean }> {
  if (!(await branchExists(root, CANDIDATE))) return { discarded: false };
  const base = await defaultBranch(root);
  await git(root, ["checkout", "-f", base]);
  await git(root, ["branch", "-D", CANDIDATE]).catch(() => {});
  return { discarded: true };
}
