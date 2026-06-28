import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";

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

// A local identity so commits never fail on a machine with no global git config.
const IDENTITY = ["-c", "user.name=BrowserOS", "-c", "user.email=bos@localhost"];

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", [...IDENTITY, ...args], {
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
async function ownsRepo(root: string): Promise<boolean> {
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
  // Seed an initial commit so branches/merges have a base to stand on.
  await fs.writeFile(path.join(root, ".gitkeep"), "");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", "init content repo"]).catch(() => {});
}

/** Stage everything under `root` and commit. No-ops when the tree is clean. */
export async function commitAll(root: string, message: string): Promise<void> {
  await ensureRepo(root);
  await git(root, ["add", "-A"]);
  const dirty = await git(root, ["status", "--porcelain"]);
  if (!dirty) return;
  await git(root, ["commit", "-q", "-m", message]).catch(() => {});
}

/** Commit history touching a given path (e.g. one app dir). Newest first. */
export async function history(
  root: string,
  relPath?: string,
  limit = 50,
): Promise<{ hash: string; date: string; message: string }[]> {
  if (!(await ownsRepo(root))) return [];
  const args = ["log", `-n${limit}`, "--pretty=format:%H%x09%cI%x09%s"];
  if (relPath) args.push("--", relPath);
  const out = await git(root, args).catch(() => "");
  if (!out) return [];
  return out.split("\n").map((line) => {
    const [hash, date, ...rest] = line.split("\t");
    return { hash, date, message: rest.join("\t") };
  });
}
