// Reproduction: a worktree DIRECTORY that git has disowned is reclaimed by
// nothing.
//
// `reconcileWorktrees` is registration-driven — it iterates
// `git worktree list --porcelain` and removes what git reports. That is the
// right shape for its job, because it safety-COMMITS a dirty worktree before
// removing it, and it can only do that for a worktree git still understands.
//
// But a directory can outlive its registration. Seen in production:
//
//   worktree health check: /worktrees/bos/switch-telegram-auto-reply has no
//     readable git dir: fatal: not a git repository:
//     /app/.git/worktrees/switch-telegram-auto-reply
//   remove of stale worktree … failed: '…' is not a working tree
//
// Once `/app/.git/worktrees/<name>` is gone — a re-clone of src/, a pruned
// registration, a hand-cleaned repo — `git worktree list` stops reporting the
// directory and the boot reaper cannot see it. Seventeen such directories sat
// on the box, each a full source tree plus a node_modules copy, and every
// cleanup the operator ran came undone because nothing reclaimed them.
//
// Data clones already have a directory-driven reaper (reconcileDataClones);
// this is its twin, with the same conservative rule:
//
//   a directory is kept for exactly as long as its branch exists.
//
// That rule costs nothing when the branch is alive — `addWorktreeForBranch`
// already `fs.rm`s a stale directory before recreating it — and it means the
// only thing ever removed is a directory whose branch has gone.
//
//   node --test tests/supervisor/worktree-dir-reaping.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeSupervisorEnv, git } from "./_data-helpers.mjs";

const env = makeSupervisorEnv("worktree-dir-reaping-");
mkdirSync(join(env.repo, "node_modules"), { recursive: true });
writeFileSync(join(env.repo, "node_modules", ".keep"), "");

const { reconcileWorktreeDirs, addWorktreeForBranch } = await import("../../tools/supervisor/lib/worktree.mjs");
const { state } = await import("../../tools/supervisor/lib/state.mjs");
const { initLogStore, getLogStore } = await import("../../tools/supervisor/lib/log.mjs");
initLogStore(env.dataDir);
await getLogStore()._ready;
state.baseBranch = env.baseBranch;

/** A directory shaped like a worktree git no longer knows about. */
function orphanDir(relative) {
  const dir = join(env.worktrees, relative);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "index.ts"), "// leftover\n");
  writeFileSync(join(dir, ".git"), "gitdir: /app/.git/worktrees/gone\n"); // the broken pointer
  return dir;
}

test("a worktree directory whose branch no longer exists is reclaimed", async () => {
  const orphan = orphanDir("bos/testfixture-disowned");
  assert.equal(existsSync(orphan), true);

  const { removed } = await reconcileWorktreeDirs();

  assert.equal(existsSync(orphan), false, "nothing else on the box reclaims these — 17 of them survived every cleanup");
  assert.ok(removed.includes(orphan), `must be reported, got ${JSON.stringify(removed)}`);
});

test("a directory whose branch still exists is kept — addWorktreeForBranch replaces it on demand", async () => {
  git(env.repo, ["branch", "bos/testfixture-branch-alive"]);
  const dir = orphanDir("bos/testfixture-branch-alive");

  const { removed } = await reconcileWorktreeDirs();

  assert.equal(existsSync(dir), true, "a live branch's directory costs nothing to keep and may hold its work");
  assert.equal(removed.includes(dir), false);
});

test("a worktree git STILL reports is never touched here — that is reconcileWorktrees' job, and it safety-commits first", async () => {
  git(env.repo, ["branch", "bos/testfixture-registered"]);
  const wt = await addWorktreeForBranch("bos/testfixture-registered");
  writeFileSync(join(wt, "uncommitted.txt"), "work in flight\n");

  const { removed } = await reconcileWorktreeDirs();

  assert.equal(existsSync(wt), true, "removing a registered worktree without the safety commit would destroy in-flight work");
  assert.equal(existsSync(join(wt, "uncommitted.txt")), true);
  assert.equal(removed.includes(wt), false);
});

test("anything outside the bos/<branch> layout is left alone", async () => {
  // WORKTREES is a configurable path and may be shared. Guessing wrong here
  // deletes a full source tree, which is strictly worse than leaking one.
  const foreign = join(env.worktrees, "not-a-branch-dir");
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, "keep.txt"), "not mine\n");

  const { removed } = await reconcileWorktreeDirs();

  assert.equal(existsSync(join(foreign, "keep.txt")), true);
  assert.equal(removed.includes(foreign), false);
});

test("a failure to list worktrees reclaims NOTHING rather than guessing", async () => {
  // If `git worktree list` cannot be read, every directory looks unregistered
  // — and sweeping on that basis would delete live worktrees wholesale.
  const orphan = orphanDir("bos/testfixture-listfail");
  const displaced = `${env.repo}.displaced`;
  const { renameSync } = await import("node:fs");
  renameSync(env.repo, displaced);
  try {
    const { removed } = await reconcileWorktreeDirs();
    assert.deepEqual(removed, [], "an unreadable worktree list must abort the sweep");
    assert.equal(existsSync(orphan), true);
  } finally {
    renameSync(displaced, env.repo);
    rmSync(orphan, { recursive: true, force: true });
  }
});

test.after(() => env.cleanup());
