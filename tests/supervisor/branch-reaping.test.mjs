// Reproduction: `bos/*` feature branches accumulated forever.
//
// A production box carried 21 of them. Three were real work; the other 18 were
// unit-test fixture names leaked in by a suite that reached the live
// Supervisor (see tests/specs/unit-suite-never-reaches-live-supervisor.test.ts
// for that half). Nothing ever removed any of them: `discardPreview` and
// `promote` delete the branch they are given, and that is the ONLY branch
// deletion in the Supervisor. A branch abandoned any other way — a leaked
// test, an interrupted delegate, a dev who changed their mind — stayed, and
// every one of them was a standing invitation to provision another
// full-data-dir clone.
//
// The reclamation rule has to be one that CANNOT eat real work:
//
//   - fully merged into the base branch (nothing on it that base lacks)
//   - not checked out in any worktree
//   - not a live preview in this process
//
// A leaked test branch is cut from base and never committed to, so it is
// merged by definition. An abandoned feature with real commits is not, and is
// kept. `git branch -d` (never `-D`) is the belt to that braces: git itself
// refuses to delete an unmerged branch.
//
// Ordering note: reconcileWorktrees() runs first at boot and safety-COMMITS
// any dirty worktree before removing it. That is what makes this safe — work
// in flight when the Supervisor restarted becomes a commit, which makes its
// branch unmerged, which protects it here.
//
//   node --test tests/supervisor/branch-reaping.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeSupervisorEnv, git } from "./_data-helpers.mjs";

const env = makeSupervisorEnv("branch-reaping-");
mkdirSync(join(env.repo, "node_modules"), { recursive: true });
writeFileSync(join(env.repo, "node_modules", ".keep"), "");

const { reconcileFeatureBranches, addWorktreeForBranch } = await import("../../tools/supervisor/lib/worktree.mjs");
const { state, previews } = await import("../../tools/supervisor/lib/state.mjs");
const { initLogStore, getLogStore } = await import("../../tools/supervisor/lib/log.mjs");
initLogStore(env.dataDir);
await getLogStore()._ready;
state.baseBranch = env.baseBranch;

function branches() {
  return git(env.repo, ["branch", "--format=%(refname:short)"]).split("\n").map((s) => s.trim()).filter(Boolean);
}

/** A branch with a commit of its own — i.e. real work base does not have. */
function branchWithWork(name, file) {
  git(env.repo, ["branch", name]);
  git(env.repo, ["checkout", "-q", name]);
  writeFileSync(join(env.repo, file), "real work\n");
  git(env.repo, ["add", "-A"]);
  git(env.repo, ["commit", "-q", "-m", `work on ${name}`]);
  git(env.repo, ["checkout", "-q", env.baseBranch]);
}

test("a leaked test branch — cut from base, never committed to — is reclaimed", async () => {
  // Exactly the shape of the 18 fixture-named branches found in production.
  for (const name of ["bos/testfixture-history", "bos/testfixture-lifecycle-test", "bos/testfixture-from-the-picker"]) git(env.repo, ["branch", name]);

  const { removed } = await reconcileFeatureBranches();

  for (const name of ["bos/testfixture-history", "bos/testfixture-lifecycle-test", "bos/testfixture-from-the-picker"]) {
    assert.equal(branches().includes(name), false, `${name} has nothing base lacks and must not survive`);
    assert.ok(removed.includes(name), `and must be reported as reclaimed, got ${JSON.stringify(removed)}`);
  }
});

test("a branch carrying real, unmerged work is never touched", async () => {
  branchWithWork("bos/testfixture-real-feature", "feature.txt");

  const { removed } = await reconcileFeatureBranches();

  assert.equal(branches().includes("bos/testfixture-real-feature"), true, "an abandoned branch with commits is someone's work, not garbage");
  assert.equal(removed.includes("bos/testfixture-real-feature"), false);
});

test("the base branch is never a candidate, merged or not", async () => {
  const { removed } = await reconcileFeatureBranches();
  assert.equal(branches().includes(env.baseBranch), true);
  assert.equal(removed.includes(env.baseBranch), false);
});

test("a branch outside the bos/ namespace is never touched, even when fully merged", async () => {
  // The Supervisor shares its repo with whatever else the user keeps in it.
  git(env.repo, ["branch", "someones-own-branch"]);

  const { removed } = await reconcileFeatureBranches();

  assert.equal(branches().includes("someones-own-branch"), true, "only bos/* is this mechanism's to delete");
  assert.equal(removed.includes("someones-own-branch"), false);
});

test("a branch checked out in a worktree is kept, even though it is merged", async () => {
  const branch = "bos/testfixture-has-a-worktree";
  git(env.repo, ["branch", branch]);
  await addWorktreeForBranch(branch);

  const { removed } = await reconcileFeatureBranches();

  assert.equal(branches().includes(branch), true, "a branch with a live worktree is in use");
  assert.equal(removed.includes(branch), false);
});

test("a branch with a live preview in this process is kept", async () => {
  const branch = "bos/testfixture-live-preview";
  git(env.repo, ["branch", branch]);
  previews.set(branch, { role: "preview", branch, worktree: "/sentinel", dataDir: "/sentinel", port: 1, state: "ready", proc: null, provisioned: true });
  try {
    const { removed } = await reconcileFeatureBranches();
    assert.equal(branches().includes(branch), true, "a running preview's branch must not be deleted out from under it");
    assert.equal(removed.includes(branch), false);
  } finally {
    previews.delete(branch);
  }
});

test("a DORMANT preview record does not protect a merged branch — that is the leaked-branch case itself", async () => {
  // restorePreviews registers every bos/* branch it finds, including the
  // leaked ones. If mere registration counted as "in use", nothing would ever
  // be reclaimed.
  const branch = "bos/testfixture-registered-but-empty";
  git(env.repo, ["branch", branch]);
  previews.set(branch, { role: "preview", branch, worktree: null, dataDir: null, port: null, state: "not-built", proc: null, provisioned: false });
  try {
    const { removed } = await reconcileFeatureBranches();
    assert.equal(branches().includes(branch), false);
    assert.ok(removed.includes(branch));
    assert.equal(previews.has(branch), false, "and its dormant record must go with it, or the toolbar lists a branch that no longer exists");
  } finally {
    previews.delete(branch);
  }
});

test.after(() => env.cleanup());
