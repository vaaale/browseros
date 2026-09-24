// Reproduction: data clones were never garbage-collected.
//
// `discardPreview` removes a preview's worktree, data clone and branch
// together, and `reconcileWorktrees` clears every leftover worktree on boot —
// but NOTHING ever removed a data clone whose branch had gone away by any
// other route. Deleting an abandoned `bos/*` branch by hand (the normal way to
// clean up) left its clone on disk forever, and `provisionClone` is
// deliberately idempotent so it would never be reclaimed by a later run
// either.
//
// On the production box that was 26 GB of clones for branches that no longer
// mattered, plus a `lifecycle-test.provisioning` staging directory abandoned
// mid-copy when the disk filled — which nothing cleans up either, because
// provisionClone only clears the staging path of the target it is currently
// provisioning.
//
// The rule being encoded: a clone is kept exactly as long as its branch
// exists. It may hold the preview's own data drift, so an EXISTING branch's
// clone must never be touched.
//
//   node --test tests/supervisor/clone-reaping.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeSupervisorEnv, git } from "./_data-helpers.mjs";

const env = makeSupervisorEnv("clone-reaping-");
const { reconcileDataClones } = await import("../../tools/supervisor/lib/worktree.mjs");
const { state } = await import("../../tools/supervisor/lib/state.mjs");
const { initLogStore, getLogStore } = await import("../../tools/supervisor/lib/log.mjs");
initLogStore(env.dataDir);
await getLogStore()._ready;
state.baseBranch = env.baseBranch;

/** A directory shaped like a real data clone, with a marker to prove identity. */
function makeClone(relative, marker = "clone content\n") {
  const dir = join(env.clones, relative);
  mkdirSync(join(dir, "vfs"), { recursive: true });
  writeFileSync(join(dir, "vfs", "MARKER"), marker);
  return dir;
}

test("a clone whose branch no longer exists is reclaimed", async () => {
  const orphan = makeClone("bos/testfixture-deleted-by-hand");
  assert.equal(existsSync(orphan), true);

  const { removed } = await reconcileDataClones();

  assert.equal(existsSync(orphan), false, "26 GB of clones for branches nobody kept is exactly what filled the disk");
  assert.ok(removed.includes(orphan), `the reclaimed paths must be reported, got ${JSON.stringify(removed)}`);
});

test("a clone whose branch still exists is left completely alone, drift included", async () => {
  git(env.repo, ["branch", "bos/testfixture-still-alive"]);
  const live = makeClone("bos/testfixture-still-alive", "the preview wrote this itself\n");

  await reconcileDataClones();

  assert.equal(existsSync(live), true, "a live branch's clone must survive");
  assert.equal(
    readFileSync(join(live, "vfs", "MARKER"), "utf8"),
    "the preview wrote this itself\n",
    "and must not be re-provisioned over — a data clone can hold the preview's own writes",
  );
});

test("an abandoned `.provisioning` staging directory is always reclaimed, even when its branch is alive", async () => {
  git(env.repo, ["branch", "bos/testfixture-interrupted"]);
  const staging = makeClone("bos/testfixture-interrupted.provisioning", "half a clone\n");
  const real = makeClone("bos/testfixture-interrupted");

  await reconcileDataClones();

  // Staging is never anything but the debris of an interrupted copy —
  // provisionClone renames it onto the target the moment it is complete.
  assert.equal(existsSync(staging), false, "an interrupted clone's staging dir is dead weight (this one was 8.5 GB on the production box)");
  assert.equal(existsSync(real), true, "…and reclaiming it must not disturb the finished clone beside it");
});

test("directories that are not ours are never touched", async () => {
  // CLONES is a configurable path and could be shared; only `bos/<branch>`
  // entries are this mechanism's to delete. Guessing wrong here deletes a
  // user's data, which is strictly worse than leaking a clone.
  const foreign = join(env.clones, "not-a-branch-dir");
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, "keep.txt"), "not mine\n");

  await reconcileDataClones();

  assert.equal(existsSync(join(foreign, "keep.txt")), true, "an entry outside the bos/<branch> layout must be left alone");
});

test("a clone for the BASE branch is never reclaimed, whatever else is going on", async () => {
  // Defensive: base is not a feature branch and has no clone by design, but a
  // reaper that can reach it is one bug away from deleting canonical-adjacent
  // state.
  const baseish = makeClone(env.baseBranch);

  await reconcileDataClones();

  assert.equal(existsSync(baseish), true);
});

test.after(() => env.cleanup());
