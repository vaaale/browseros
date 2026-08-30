import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getGitIdentity } from "@/lib/config/store";

// GitFS — a thin git layer over a content directory. It backs *versioned*,
// user-authored, shareable content (apps today; workflows later), as opposed to
// DataFS which holds ephemeral runtime state. Each GitFS root is its OWN
// standalone repo (independent of the BOS source repo), so git handles history,
// branching, and — eventually — a community marketplace (clone/push/pull).
//
// This module is the BOS-server side (read/write/commit). The Supervisor drives
// candidate branches/worktrees for preview/promote/discard via its own git calls
// against the same root.

const exec = promisify(execFile);

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

// Whether `root` is its OWN git repo. We check for `<root>/.git` directly rather
// than `git rev-parse`, because a plain `git` command inside a not-yet-initialized
// dir would walk UP and find the enclosing BOS repo — we must never operate on
// that. ensureRepo() must run before any git command in a fresh root.
export async function ownsRepo(root: string): Promise<boolean> {
  try {
    await fs.access(path.join(root, ".git"));
    return true;
  } catch {
    return false;
  }
}

/** Ensure `root` exists and is a git repo with at least one commit. Idempotent. */
export async function ensureRepo(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  if (await ownsRepo(root)) return;
  await git(root, ["init", "-q"]);
  // Seed an initial commit so branches/merges have a base to stand on. This
  // is a brand-new repo (guarded by the ownsRepo() return above), so there is
  // no legitimate "nothing to commit" case here — unlike commitAll, any
  // commit failure is a real problem and must throw, not be swallowed:
  // ownsRepo() only checks for `.git`'s existence, not commit count, so a
  // silently-failed commit here would permanently leave a zero-commit repo
  // that every later `ensureRepo()` call short-circuits past, breaking this
  // function's own documented "at least one commit" invariant.
  await fs.writeFile(path.join(root, ".gitkeep"), "");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", "init content repo"]);
}

/** Stage everything under `root` and commit. No-ops when the tree is clean. */
export async function commitAll(root: string, message: string): Promise<void> {
  await ensureRepo(root);
  await git(root, ["add", "-A"]);
  const dirty = await git(root, ["status", "--porcelain"]);
  if (!dirty) return;
  try {
    await git(root, ["commit", "-q", "-m", message]);
  } catch (err: unknown) {
    // A concurrent writer may have already committed our staged changes between
    // the status check and the commit — treat that as success, re-throw anything else.
    const msg = String((err as { stderr?: string; stdout?: string; message?: string })?.stderr ?? (err as { message?: string })?.message ?? err);
    if (!msg.includes("nothing to commit")) throw err;
  }
}

/** Stage and commit only the subtree at `root`, which is a directory INSIDE an
 *  already-initialized repo (e.g. one item's `spec/` folder inside the shared
 *  `user-apps` repo) rather than a repo root itself. Unlike `commitAll`, this
 *  never calls `ensureRepo` — doing so on a bare subdirectory would `git init`
 *  a stray nested repo there — and it pathspec-scopes both the add and the
 *  commit to `.` so a save inside one item never sweeps in another item's
 *  unrelated unstaged changes elsewhere in the same shared repo. */
export async function commitScoped(root: string, message: string): Promise<void> {
  await git(root, ["add", "-A", "."]);
  const dirty = await git(root, ["status", "--porcelain", "."]);
  if (!dirty) return;
  try {
    await git(root, ["commit", "-q", "-m", message, "--", "."]);
  } catch (err: unknown) {
    const msg = String((err as { stderr?: string; stdout?: string; message?: string })?.stderr ?? (err as { message?: string })?.message ?? err);
    if (!msg.includes("nothing to commit")) throw err;
  }
}

/** Commit history touching a given path (e.g. one app dir). Newest first. */
export async function history(
  root: string,
  relPath?: string,
  limit = 50,
  opts: { all?: boolean } = {},
): Promise<{ hash: string; date: string; message: string }[]> {
  // `root` must be the owning REPO root (SpecStore.repoRoot), not a content
  // root: an item-owned store's content lives in a subdirectory of user-apps
  // and has no `.git` of its own. This used to be guarded by `ownsRepo(root)`
  // returning [] — which turned "you passed the wrong root" into "this file
  // has no history", indistinguishable from a genuinely new file, and hid the
  // item-store history bug completely. Fail loudly instead.
  if (!(await ownsRepo(root))) {
    throw new Error(`history(): "${root}" is not a git repository root — pass the store's repoRoot, not its content root.`);
  }
  // `all` walks every branch's history, not just the currently checked-out
  // one — a store is one on-disk repo with draft `bos/*` branches as
  // additional refs in the SAME repo, so a file's full version history can
  // span commits that never reached the default branch (037-project-layer).
  const args = ["log", `-n${limit}`, "--pretty=format:%H%x09%cI%x09%s", ...(opts.all ? ["--all"] : [])];
  if (relPath) args.push("--", relPath);
  // No catch-all here either: `git log` on a path with no commits exits 0 with
  // empty output, so a THROW is a real failure (bad ref, unreadable repo) and
  // must reach the caller rather than being flattened into "no history".
  const out = await git(root, args);
  if (!out) return [];
  return out.split("\n").map((line) => {
    const [hash, date, ...rest] = line.split("\t");
    return { hash, date, message: rest.join("\t") };
  });
}
