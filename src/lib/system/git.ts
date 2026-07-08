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

/** List existing `bos/*` feature branch refs (read-only, allowed under the
 *  Supervisor since the worktrees share one `.git`). Used to offer resumable
 *  branches in the Assistant. */
export async function listFeatureBranches(): Promise<string[]> {
  try {
    const out = await git(["for-each-ref", "--format=%(refname:short)", "refs/heads/bos"]);
    return out ? out.split("\n").map((l) => l.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function featureBranchName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9/_-]+/g, "-").replace(/^-+|-+$/g, "") || "change";
  return slug.startsWith("bos/") ? slug : `bos/${slug}`;
}

/** Create (or switch to) a `bos/<name>` feature branch. Refused under the
 *  Supervisor — switching the live checkout's branch breaks the running base. */
export async function createFeatureBranch(name: string): Promise<string> {
  if (supervised()) throw new Error(SUPERVISOR_OWNS_GIT);
  const branch = featureBranchName(name);
  try {
    await git(["rev-parse", "--verify", branch]);
    await git(["checkout", branch]);
  } catch {
    await git(["checkout", "-b", branch]);
  }
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
