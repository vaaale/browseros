import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Scoped, non-destructive git helper for the "minimize blast radius" policy:
// BOS self-modification happens on a feature branch with files staged. Only
// branch/add/status are allowed — no commit, push, reset, checkout-discard.
const exec = promisify(execFile);
const REPO = process.cwd();

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

function featureBranchName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9/_-]+/g, "-").replace(/^-+|-+$/g, "") || "change";
  return slug.startsWith("bos/") ? slug : `bos/${slug}`;
}

/** Create (or switch to) a `bos/<name>` feature branch. */
export async function createFeatureBranch(name: string): Promise<string> {
  const branch = featureBranchName(name);
  try {
    await git(["rev-parse", "--verify", branch]);
    await git(["checkout", branch]);
  } catch {
    await git(["checkout", "-b", branch]);
  }
  return branch;
}

/** Stage specific files (git add). Paths are validated to stay inside the repo. */
export async function stageFiles(paths: string[]): Promise<number> {
  const safe = paths
    .map((p) => p.replace(/^\/+/, "").trim())
    .filter((p) => p && !p.includes("..") && !p.startsWith("-"));
  if (safe.length === 0) return 0;
  await git(["add", "--", ...safe]);
  return safe.length;
}
