// Unit tests for tools/supervisor/lib/worktree.mjs's data-clone and
// node_modules provisioning (042-worktree-collision hardening).
//
// Regression coverage for the bug found in review: `provisionClone`'s
// existence check used to be "does the target directory exist" — which
// can't distinguish a finished clone from one interrupted mid-copy (a
// Supervisor crash/restart, a killed `cp`, disk full). A partial clone left
// the target directory in place, so every later call silently treated it as
// already-provisioned forever. The fix stages the copy into a sibling
// `<target>.provisioning` path and only `rename`s it onto `target` once
// complete — `target` can now never exist in a partial state. Same fix,
// same tests, for `hydrateWorktree`'s node_modules copy.
//
//   node --test tests/supervisor/worktree-provisioning.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeSupervisorEnv, git, writeMarker, readMarker } from "./_data-helpers.mjs";

const env = makeSupervisorEnv("wt-provision-");
const { provisionClone, hydrateWorktree, isHealthyWorktree, addWorktreeForBranch } = await import("../../tools/supervisor/lib/worktree.mjs");
const { initLogStore } = await import("../../tools/supervisor/lib/log.mjs");
initLogStore(env.dataDir); // silences "log write dropped" noise from slog() calls in the code under test

// Seed CANONICAL_DATA with some real content so a clone has something to prove it copied.
mkdirSync(join(env.dataDir, "vfs", "Documents"), { recursive: true });
writeFileSync(join(env.dataDir, "vfs", "Documents", "hello.txt"), "canonical content\n");

test("provisionClone: fresh clone copies canonical data and cleans up its own staging dir", async () => {
  const target = join(env.clones, "fresh-clone");
  await provisionClone(target);
  assert.equal(existsSync(target), true, "target must exist after a successful clone");
  assert.equal(await readFile(join(target, "vfs", "Documents", "hello.txt"), "utf8"), "canonical content\n");
  assert.equal(existsSync(`${target}.provisioning`), false, "staging dir must not survive a successful provision");
});

test("provisionClone: idempotent — an already-provisioned clone is never touched again", async () => {
  const target = join(env.clones, "idempotent-clone");
  await provisionClone(target);
  await writeMarker(target, "drift.txt", "the preview wrote this itself\n");
  await provisionClone(target); // must be a no-op
  assert.equal(await readMarker(target, "drift.txt"), "the preview wrote this itself\n", "a second provisionClone must never re-copy over local drift");
});

test("provisionClone: a leftover staging dir from an interrupted PREVIOUS attempt never gets mistaken for a finished clone", async () => {
  const target = join(env.clones, "interrupted-clone");
  const staging = `${target}.provisioning`;
  // Simulate a crash mid-copy: the staging dir exists (partially populated,
  // missing the real content) but `target` itself was never created.
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, "PARTIAL"), "this is not a real clone\n");
  assert.equal(existsSync(target), false);

  await provisionClone(target);

  assert.equal(existsSync(target), true, "target must now exist, fully provisioned");
  assert.equal(await readFile(join(target, "vfs", "Documents", "hello.txt"), "utf8"), "canonical content\n", "must be a genuine, complete clone, not the partial leftover");
  assert.equal(existsSync(join(target, "PARTIAL")), false, "the stale partial marker must not have survived into the real clone");
  assert.equal(existsSync(staging), false, "the staging dir must be gone once promoted");
});

test("provisionClone: an item's system/<id> symlink installed on base (absolute, pointing at CANONICAL_DATA) is retargeted into the clone's OWN user-apps — a marketplace-provenance symlink is left untouched", async () => {
  const { symlink, mkdir, writeFile, readFile, readlink } = await import("node:fs/promises");

  // Mirrors installItemLink's real, unconditional `fs.symlink(path.resolve(itemPath), link, "dir")` —
  // both an item that came from user-apps (branch-coupled, mounted per preview)
  // and one from a marketplace clone (NOT branch-coupled — no per-clone copy to redirect to).
  await mkdir(join(env.dataDir, "user-apps", "items", "some-item"), { recursive: true });
  await writeFile(join(env.dataDir, "user-apps", "items", "some-item", "canonical-marker.txt"), "canonical copy\n");
  await mkdir(join(env.dataDir, "marketplace", "some-mkt", "items", "mkt-item"), { recursive: true });
  await mkdir(join(env.dataDir, "system"), { recursive: true });
  await symlink(join(env.dataDir, "user-apps", "items", "some-item"), join(env.dataDir, "system", "some-item"), "dir");
  await symlink(join(env.dataDir, "marketplace", "some-mkt", "items", "mkt-item"), join(env.dataDir, "system", "mkt-item"), "dir");

  const target = join(env.clones, "symlink-retarget-clone");
  await provisionClone(target);

  const itemLinkTarget = await readlink(join(target, "system", "some-item"));
  assert.equal(itemLinkTarget, join(target, "user-apps", "items", "some-item"), "a user-apps-sourced item symlink must be retargeted to point into THIS clone's own user-apps, not back into CANONICAL_DATA");

  const mktLinkTarget = await readlink(join(target, "system", "mkt-item"));
  assert.equal(mktLinkTarget, join(env.dataDir, "marketplace", "some-mkt", "items", "mkt-item"), "a marketplace-provenance symlink has no clone-local equivalent and must be left pointing at canonical, unchanged");

  // Prove it's not just path arithmetic: an edit written into the CLONE's own
  // user-apps (what mountCoupled mounts a branch-coupled worktree onto) must
  // actually be visible through the retargeted system/<id> symlink.
  await writeFile(join(target, "user-apps", "items", "some-item", "clone-marker.txt"), "edited inside this preview\n");
  assert.equal(
    await readFile(join(target, "system", "some-item", "clone-marker.txt"), "utf8"),
    "edited inside this preview\n",
    "reading through the retargeted symlink must reach the CLONE's own (edited) content",
  );
});

test("provisionClone: total copy failure throws rather than leaving a broken clone behind", async () => {
  // config.mjs's CANONICAL_DATA is frozen to env.dataDir at first import
  // (see _data-helpers.mjs's header) — a second env's own dataDir would have
  // no effect, so this test instead makes THAT exact path vanish temporarily.
  const target = join(env.clones, "should-not-exist");
  const displaced = `${env.dataDir}.displaced-for-test`;
  renameSync(env.dataDir, displaced);
  try {
    await assert.rejects(provisionClone(target));
    assert.equal(existsSync(target), false, "a total failure must never leave `target` in place");
    assert.equal(existsSync(`${target}.provisioning`), false, "and must not leave the staging dir behind either");
  } finally {
    renameSync(displaced, env.dataDir); // restore for every other test in this file
  }
});

// Runs BEFORE the "copies node_modules" test below deliberately: REPO's
// node_modules doesn't exist yet at this point (config.mjs's REPO constant
// is frozen to env.repo — a separate env's own repo would have no effect —
// so ordering, not a fresh fixture, is what keeps this deterministic).
test("hydrateWorktree: total copy failure throws (never silently leaves node_modules missing)", async () => {
  assert.equal(existsSync(join(env.repo, "node_modules")), false, "precondition: REPO must not have node_modules yet");
  const wt = join(env.worktrees, "hydrate-fail-target");
  mkdirSync(wt, { recursive: true });
  await assert.rejects(hydrateWorktree(wt));
  assert.equal(existsSync(join(wt, "node_modules")), false, "must not report success with node_modules silently missing");
});

test("hydrateWorktree: copies node_modules into the worktree via staging + atomic rename", async () => {
  mkdirSync(join(env.repo, "node_modules", "some-pkg"), { recursive: true });
  writeFileSync(join(env.repo, "node_modules", "some-pkg", "index.js"), "module.exports = 1;\n");

  const wt = join(env.worktrees, "hydrate-target");
  mkdirSync(wt, { recursive: true });
  await hydrateWorktree(wt);

  assert.equal(existsSync(join(wt, "node_modules", "some-pkg", "index.js")), true);
  assert.equal(existsSync(`${join(wt, "node_modules")}.provisioning`), false);
});

test("addWorktreeForBranch: creates a fresh worktree checked out on a new branch, with node_modules hydrated", async () => {
  mkdirSync(join(env.repo, "node_modules"), { recursive: true });
  writeFileSync(join(env.repo, "node_modules", ".keep"), "");

  git(env.repo, ["branch", "bos/feature-one"]);
  const wt = await addWorktreeForBranch("bos/feature-one");

  assert.equal(git(wt, ["rev-parse", "--abbrev-ref", "HEAD"]), "bos/feature-one");
  assert.equal(existsSync(join(wt, "node_modules", ".keep")), true);
});

test("addWorktreeForBranch: reuses an already-healthy worktree instead of recreating it", async () => {
  git(env.repo, ["branch", "bos/feature-reuse"]);
  const wt1 = await addWorktreeForBranch("bos/feature-reuse");
  await writeMarker(wt1, "MARKER", "first provision\n");

  const wt2 = await addWorktreeForBranch("bos/feature-reuse");
  assert.equal(wt2, wt1);
  assert.equal(await readMarker(wt2, "MARKER"), "first provision\n", "a healthy worktree must be reused, not torn down and recreated");
});

test("addWorktreeForBranch: an unhealthy worktree (node_modules missing) is torn down and recreated, not silently reused", async () => {
  git(env.repo, ["branch", "bos/feature-stale"]);
  const wt = await addWorktreeForBranch("bos/feature-stale");
  await writeMarker(wt, "MARKER", "will be discarded\n");

  // Simulate an interrupted/corrupted prior hydration: node_modules missing
  // is exactly what isHealthyWorktree treats as unhealthy.
  await import("node:fs").then((fs) => fs.rmSync(join(wt, "node_modules"), { recursive: true, force: true }));
  assert.equal(await isHealthyWorktree(wt, "bos/feature-stale"), false, "missing node_modules must be reported as unhealthy");

  const recreated = await addWorktreeForBranch("bos/feature-stale");
  assert.equal(await readMarker(recreated, "MARKER"), null, "an unhealthy worktree must be torn down, not silently reused");
  assert.equal(existsSync(join(recreated, "node_modules")), true, "the recreated worktree must be freshly hydrated");
});

test.after(() => env.cleanup());
