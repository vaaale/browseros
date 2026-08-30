// Unit tests for the branch-create / worktree add-remove primitives added to
// git-ops.ts for the lightweight per-Project git flow (037-project-layer,
// Phase 2). Written BEFORE the implementation (TDD) — git-ops.ts has no
// branch-create or worktree function today (only switchBranch = checkout an
// EXISTING branch), so these must fail until createBranch/addWorktree/
// removeWorktree/deleteBranch are added.
//   npm run test:unit -- tests/gitops/worktree-ops.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { createBranch, addWorktree, removeWorktree, deleteBranch } from "../../src/lib/gitops/git-ops";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
}

function makeRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "worktree-ops-"));
  git(dir, ["init", "-q"]);
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("createBranch creates a new branch off the current HEAD without checking it out", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    const before = git(dir, ["branch", "--show-current"]);
    await createBranch(dir, "feature/foo");
    const branches = git(dir, ["branch", "--list", "feature/foo"]);
    expect(branches).toContain("feature/foo");
    // Still on the original branch — createBranch never checks out.
    expect(git(dir, ["branch", "--show-current"])).toBe(before);
  } finally {
    cleanup();
  }
});

test("createBranch accepts an explicit start point", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    const base = git(dir, ["rev-parse", "HEAD"]);
    writeFileSync(join(dir, "second.md"), "more\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "second commit"]);

    await createBranch(dir, "feature/from-base", base);
    expect(git(dir, ["rev-parse", "feature/from-base"])).toBe(base);
  } finally {
    cleanup();
  }
});

test("createBranch fails clearly when the branch already exists", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    await createBranch(dir, "feature/dup");
    // Note: git-ops.ts's makeError() rejects with a plain {code, message}
    // object, not an Error instance, so `.rejects.toThrow()` can't detect it
    // (it silently reports "did not throw") — assert on the object's shape.
    await expect(createBranch(dir, "feature/dup")).rejects.toMatchObject({ code: "GIT_CREATE_BRANCH_FAILED" });
  } finally {
    cleanup();
  }
});

test("addWorktree checks out an existing branch into a new worktree directory", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    await createBranch(dir, "feature/foo");
    const wtPath = join(dir, "..", `${join(dir).split("/").pop()}-wt-foo`);
    await addWorktree(dir, wtPath, "feature/foo");
    try {
      expect(existsSync(join(wtPath, "README.md"))).toBe(true);
      expect(git(wtPath, ["branch", "--show-current"])).toBe("feature/foo");
    } finally {
      rmSync(wtPath, { recursive: true, force: true });
      git(dir, ["worktree", "prune"]);
    }
  } finally {
    cleanup();
  }
});

test("removeWorktree removes the worktree directory and its registration", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    await createBranch(dir, "feature/foo");
    const wtPath = join(dir, "..", `${join(dir).split("/").pop()}-wt-remove`);
    await addWorktree(dir, wtPath, "feature/foo");
    expect(existsSync(wtPath)).toBe(true);

    await removeWorktree(dir, wtPath);

    expect(existsSync(wtPath)).toBe(false);
    expect(git(dir, ["worktree", "list"])).not.toContain(wtPath);
  } finally {
    cleanup();
  }
});

test("removeWorktree({force: true}) removes a worktree with uncommitted changes", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    await createBranch(dir, "feature/dirty");
    const wtPath = join(dir, "..", `${join(dir).split("/").pop()}-wt-dirty`);
    await addWorktree(dir, wtPath, "feature/dirty");
    writeFileSync(join(wtPath, "uncommitted.md"), "wip\n");

    await removeWorktree(dir, wtPath, { force: true });
    expect(existsSync(wtPath)).toBe(false);
  } finally {
    cleanup();
  }
});

test("deleteBranch deletes a fully-merged branch; force deletes an unmerged one", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    await createBranch(dir, "feature/merged");
    await deleteBranch(dir, "feature/merged");
    expect(git(dir, ["branch", "--list", "feature/merged"])).toBe("");

    await createBranch(dir, "feature/unmerged");
    const wtPath = join(dir, "..", `${join(dir).split("/").pop()}-wt-unmerged`);
    await addWorktree(dir, wtPath, "feature/unmerged");
    writeFileSync(join(wtPath, "divergent.md"), "divergent\n");
    git(wtPath, ["add", "-A"]);
    git(wtPath, ["commit", "-q", "-m", "divergent commit"]);
    await removeWorktree(dir, wtPath, { force: true });

    await expect(deleteBranch(dir, "feature/unmerged")).rejects.toMatchObject({ code: "GIT_DELETE_BRANCH_FAILED" });
    await deleteBranch(dir, "feature/unmerged", { force: true });
    expect(git(dir, ["branch", "--list", "feature/unmerged"])).toBe("");
  } finally {
    cleanup();
  }
});
