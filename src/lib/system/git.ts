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
