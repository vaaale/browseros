// Unit tests for tools/supervisor/lib/coupled-repos.mjs — the one feature =
// one branch name mechanism spec stores and user-apps (the data-clone-
// resident marketplace repo) share (020-branch-coupled-specs).
//
// Includes a regression test for the mountCoupled race fix
// (042-worktree-collision): two overlapping `/begin` calls (e.g. parallel
// agent tool calls) can both see a branch as not-yet-existing and both try
// `worktree add -b`; the loser used to fail outright with "a branch named …
// already exists", leaving `specs/<store>` unmounted in that preview with no
// loud error — which reads as a bafflingly "blank" preview. The fix makes
// mounting a branch that already exists (however it came to exist) succeed
// by checking it out instead of failing.
//
//   node --test tests/supervisor/coupled-repos.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeSupervisorEnv, makeSpecStore, git } from "./_data-helpers.mjs";

const env = makeSupervisorEnv("coupled-repos-");
const {
  listSpecStores,
  mountedSpecStoresIn,
  coupledReposFor,
  ensureAppsRepo,
  mountCoupled,
  commitCoupled,
  promoteCoupled,
  discardCoupled,
} = await import("../../tools/supervisor/lib/coupled-repos.mjs");
const { initLogStore } = await import("../../tools/supervisor/lib/log.mjs");
initLogStore(env.dataDir);

const specsRoot = join(env.dataDir, "specs");
mkdirSync(specsRoot, { recursive: true });
const systemStore = makeSpecStore(specsRoot, "bos-system-specs", "master");
const userStore = makeSpecStore(specsRoot, "user-specs", "master");

test("listSpecStores: discovers every directory with .git + spec-store.json, ignores the rest", async () => {
  mkdirSync(join(specsRoot, "not-a-store"), { recursive: true }); // no .git, no spec-store.json
  const stores = await listSpecStores();
  const ids = stores.map((s) => s.id).sort();
  assert.deepEqual(ids, ["bos-system-specs", "user-specs"]);
});

test("coupledReposFor: stores mount nested under the worktree; user-apps is data-clone-rooted", async () => {
  // specStoreReposFor is GONE — it returned every store WITH a mount
  // destination, and beginPreview mounted from it, which is how a marketplace
  // change kept creating bos/* in every registered repository long after
  // coupledReposFor was scoped. What replaced it (mountedSpecStoresIn) reads
  // what is actually mounted on disk and is for teardown only.
  const wt = "/fake/worktree";
  const dataDir = "/fake/dataDir";

  // Unscoped: BOS's own repos, never a registered one.
  const all = await coupledReposFor(wt, dataDir, "bos/testfixture-unscoped-example");
  assert.deepEqual(all.map((r) => r.id).sort(), ["user-apps", "user-specs"]);
  const store = all.find((r) => r.kind === "spec-store");
  assert.equal(store.dst, join(wt, "specs", store.id), "a spec store mounts inside the code worktree");
  const userApps = all.find((r) => r.kind === "user-apps");
  assert.ok(userApps, "user-apps must be included");
  assert.equal(userApps.dst, join(dataDir, "user-apps"), "user-apps mounts inside the DATA clone, not the code worktree");

  // The read-only system store is excluded from every scope.
  assert.ok(!all.some((r) => r.id === "bos-system-specs"), "bos-system-specs is read-only and never coupled");
});

test("mountedSpecStoresIn: reads the mounts on disk, and an absent specs/ is not an error", async () => {
  assert.deepEqual(await mountedSpecStoresIn(join(env.dataDir, "no-such-worktree")), []);
});

test("ensureAppsRepo: idempotent — creates the repo with an init commit once, never twice", async () => {
  await ensureAppsRepo();
  assert.equal(existsSync(join(env.dataDir, "user-apps", ".git")), true);
  const firstTip = git(join(env.dataDir, "user-apps"), ["rev-parse", "HEAD"]);
  await ensureAppsRepo();
  assert.equal(git(join(env.dataDir, "user-apps"), ["rev-parse", "HEAD"]), firstTip, "a second call must not add another init commit");
});

test("mountCoupled: fresh mount creates a new branch off the store's default and checks it out", async () => {
  const dst = join(env.worktrees, "mount-fresh", "specs", "bos-system-specs");
  await mountCoupled({ id: "bos-system-specs", root: systemStore, kind: "spec-store" }, dst, "bos/testfixture-fresh-mount");
  assert.equal(git(dst, ["rev-parse", "--abbrev-ref", "HEAD"]), "bos/testfixture-fresh-mount");
  assert.equal(git(systemStore, ["rev-parse", "bos/testfixture-fresh-mount"]), git(systemStore, ["rev-parse", "master"]), "new branch must start at the store's default tip");
});

test("mountCoupled: already-correctly-mounted is a no-op (idempotent)", async () => {
  const dst = join(env.worktrees, "mount-idempotent", "specs", "bos-system-specs");
  await mountCoupled({ id: "bos-system-specs", root: systemStore, kind: "spec-store" }, dst, "bos/testfixture-idempotent-mount");
  writeFileSync(join(dst, "local-drift.txt"), "must survive a second mount call\n");
  await mountCoupled({ id: "bos-system-specs", root: systemStore, kind: "spec-store" }, dst, "bos/testfixture-idempotent-mount");
  assert.equal(existsSync(join(dst, "local-drift.txt")), true, "a second mount of an already-correct worktree must not remount/wipe it");
});

test("mountCoupled: mounting a branch that ALREADY EXISTS (e.g. another caller won a create race) succeeds by checking it out, not failing", async () => {
  // Simulate the losing side of the race this fix targets: the branch was
  // already created (by a concurrent caller, or here, just directly) before
  // this mountCoupled call ever runs, and nothing is mounted for it yet.
  git(systemStore, ["branch", "bos/testfixture-race-winner-created"]);
  const dst = join(env.worktrees, "mount-race", "specs", "bos-system-specs");
  await mountCoupled({ id: "bos-system-specs", root: systemStore, kind: "spec-store" }, dst, "bos/testfixture-race-winner-created");
  assert.equal(git(dst, ["rev-parse", "--abbrev-ref", "HEAD"]), "bos/testfixture-race-winner-created");
});

test("commitCoupled: commits dirty changes; is a no-op on a clean mount; is a no-op when not mounted at all", async () => {
  const dst = join(env.worktrees, "commit-coupled", "specs", "bos-system-specs");
  await mountCoupled({ id: "bos-system-specs", root: systemStore, kind: "spec-store" }, dst, "bos/testfixture-commit-test");
  const tipBefore = git(dst, ["rev-parse", "HEAD"]);

  // Not mounted at all — must not throw.
  await commitCoupled({ id: "bos-system-specs", root: systemStore, kind: "spec-store" }, join(env.worktrees, "never-mounted"), "bos/testfixture-commit-test");

  // Clean mount — must not throw, must not create an empty commit.
  await commitCoupled({ id: "bos-system-specs", root: systemStore, kind: "spec-store" }, dst, "bos/testfixture-commit-test");
  assert.equal(git(dst, ["rev-parse", "HEAD"]), tipBefore, "nothing to commit must not produce a commit");

  // Dirty mount — must commit.
  writeFileSync(join(dst, "spec.md"), "# work in progress\n");
  await commitCoupled({ id: "bos-system-specs", root: systemStore, kind: "spec-store" }, dst, "bos/testfixture-commit-test");
  assert.notEqual(git(dst, ["rev-parse", "HEAD"]), tipBefore, "a dirty mount must gain a commit");
  assert.equal(git(dst, ["status", "--porcelain"]), "", "the worktree must be clean again after committing");
});

test("promoteCoupled: merges the branch into the store's default, then drops the branch and worktree", async () => {
  const dst = join(env.worktrees, "promote-coupled", "specs", "bos-system-specs");
  const repo = { id: "bos-system-specs", root: systemStore, kind: "spec-store" };
  await mountCoupled(repo, dst, "bos/testfixture-promote-test");
  writeFileSync(join(dst, "feature.md"), "# the feature\n");
  await commitCoupled(repo, dst, "bos/testfixture-promote-test");

  const warnings = [];
  await promoteCoupled(repo, "bos/testfixture-promote-test", dst, warnings, () => {});

  assert.deepEqual(warnings, [], `promoteCoupled must not warn on a clean merge: ${warnings.join("; ")}`);
  assert.equal(existsSync(dst), false, "the worktree must be gone after promote");
  assert.throws(() => git(systemStore, ["rev-parse", "--verify", "refs/heads/bos/testfixture-promote-test"]), "the branch must be deleted after a successful merge");
  assert.equal(existsSync(join(systemStore, "feature.md")), true, "the merge must have landed on — and updated the working tree of — the store's primary checkout");
});

test("discardCoupled: removes the worktree and deletes the branch WITHOUT merging — uncommitted work is deliberately dropped", async () => {
  const dst = join(env.worktrees, "discard-coupled", "specs", "user-specs");
  const repo = { id: "user-specs", root: userStore, kind: "spec-store" };
  await mountCoupled(repo, dst, "bos/testfixture-discard-test");
  writeFileSync(join(dst, "throwaway.md"), "# never meant to land\n");

  const warnings = [];
  await discardCoupled(repo, "bos/testfixture-discard-test", dst, warnings);

  assert.deepEqual(warnings, []);
  assert.equal(existsSync(dst), false, "the worktree must be gone");
  assert.equal(existsSync(join(userStore, "throwaway.md")), false, "discarded content must never reach the store's primary checkout");
});

test.after(() => env.cleanup());
