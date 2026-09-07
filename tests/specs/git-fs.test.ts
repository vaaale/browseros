// Unit tests for the git worktree + commit helpers behind SpecFS
// (src/os/fs/git-fs.ts). Exercised only incidentally elsewhere (via SpecFS's
// own tests, which cover the split-brain worktree-handoff logic but not this
// module's own success/failure branches directly) — this covers git(),
// defaultBranch(), ensureWorktree()'s reuse/existing-branch paths,
// pruneWorktree()'s failure-tolerance, commit(), and workingDiff() directly.
//   npm run test:unit -- tests/specs/git-fs.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { tmpdir } from "os";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import {
  git,
  defaultBranch,
  ensureWorktree,
  pruneWorktree,
  commit,
  workingDiff,
} from "../../src/os/fs/git-fs";

// Real git repos for these tests MUST live OUTSIDE this repo's own working
// tree (os.tmpdir(), not useTestDataDir()'s dir under tests/services/.tmp) —
// git commands in an otherwise-bare subdirectory walk UP to the nearest
// enclosing .git, so a "not a repo" fixture nested inside browseros itself
// would silently resolve to BOS's own repo and its actual checked-out branch.
function scratchDir(label: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `${label}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function sysGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
}

function initRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  sysGit(root, ["init", "--quiet", "--initial-branch=main"]);
  writeFileSync(join(root, "README.md"), "# repo\n");
  sysGit(root, ["add", "-A"]);
  sysGit(root, ["commit", "--quiet", "-m", "initial"]);
}

test("git() throws a contextual error when the command fails", async () => {
  const { dir, cleanup } = scratchDir("git-fs-command-fails");
  try {
    const root = join(dir, "not-a-repo");
    mkdirSync(root, { recursive: true });
    await expect(git(root, ["symbolic-ref", "--short", "HEAD"])).rejects.toThrow(/git symbolic-ref failed in/);
  } finally {
    cleanup();
  }
});

test("defaultBranch() returns the checked-out branch, or 'main' when there is none to read", async () => {
  const { dir, cleanup } = scratchDir("git-fs-default-branch");
  try {
    const repo = join(dir, "repo");
    initRepo(repo);
    expect(await defaultBranch(repo)).toBe("main");

    const notARepo = join(dir, "empty");
    mkdirSync(notARepo, { recursive: true });
    expect(await defaultBranch(notARepo)).toBe("main");
  } finally {
    cleanup();
  }
});

test("ensureWorktree() reuses an already-provisioned worktree instead of re-adding it", async () => {
  const { dir, cleanup } = scratchDir("git-fs-worktree-reuse");
  try {
    const repo = join(dir, "repo");
    initRepo(repo);
    const worktreePath = join(dir, "wt");

    const first = await ensureWorktree(repo, worktreePath, "bos/feature");
    expect(existsSync(join(first, ".git"))).toBe(true);

    // Second call must short-circuit on the existing worktree, not attempt
    // `git worktree add` again (which would fail — the branch is already
    // checked out there).
    const second = await ensureWorktree(repo, worktreePath, "bos/feature");
    expect(second).toBe(worktreePath);
  } finally {
    cleanup();
  }
});

test("ensureWorktree() checks out an EXISTING local branch rather than creating a new one", async () => {
  const { dir, cleanup } = scratchDir("git-fs-worktree-existing-branch");
  try {
    const repo = join(dir, "repo");
    initRepo(repo);
    sysGit(repo, ["branch", "bos/already-exists"]);

    const worktreePath = join(dir, "wt");
    await ensureWorktree(repo, worktreePath, "bos/already-exists");

    expect(sysGit(worktreePath, ["symbolic-ref", "--short", "HEAD"])).toBe("bos/already-exists");
  } finally {
    cleanup();
  }
});

test("pruneWorktree() tolerates a worktree that's already gone — logs and still prunes", async () => {
  const { dir, cleanup } = scratchDir("git-fs-prune-tolerant");
  try {
    const repo = join(dir, "repo");
    initRepo(repo);
    // Never provisioned via `git worktree add` — the remove step must fail
    // internally without pruneWorktree() itself throwing.
    await expect(pruneWorktree(repo, join(dir, "never-existed"))).resolves.toBeUndefined();
  } finally {
    cleanup();
  }
});

test("commit() is a no-op on a clean tree and commits when dirty", async () => {
  const { dir, cleanup } = scratchDir("git-fs-commit");
  try {
    const repo = join(dir, "repo");
    initRepo(repo);
    const before = sysGit(repo, ["rev-parse", "HEAD"]);

    await commit(repo, "no-op commit");
    expect(sysGit(repo, ["rev-parse", "HEAD"])).toBe(before);

    writeFileSync(join(repo, "new-file.txt"), "content");
    await commit(repo, "add new-file.txt");
    expect(sysGit(repo, ["rev-parse", "HEAD"])).not.toBe(before);
    expect(sysGit(repo, ["log", "-1", "--format=%s"])).toBe("add new-file.txt");
  } finally {
    cleanup();
  }
});

test("workingDiff() reports staged+unstaged changes and is empty on a clean tree", async () => {
  const { dir, cleanup } = scratchDir("git-fs-working-diff");
  try {
    const repo = join(dir, "repo");
    initRepo(repo);
    expect(await workingDiff(repo)).toBe("");

    writeFileSync(join(repo, "README.md"), "# repo\n\nchanged\n");
    const diff = await workingDiff(repo);
    expect(diff).toContain("README.md");
    expect(diff).toContain("changed");
  } finally {
    cleanup();
  }
});
