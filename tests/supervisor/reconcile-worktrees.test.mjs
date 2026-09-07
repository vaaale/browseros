// Regression tests for tools/supervisor/lib/worktree.mjs's reconcileWorktrees
// (042-worktree-collision hardening).
//
// Before the fix, reconcileWorktrees() unconditionally force-removed every
// worktree under WORKTREES/ on every Supervisor boot — including any with
// UNCOMMITTED edits (an agent's dev_delegate had written files but the
// Supervisor restarted before buildAndStart's own commit step ran). The
// branch survived (it's just a git ref) but whatever hadn't been committed
// onto it was silently destroyed the moment `fs.rm` ran. The fix
// safety-commits any dirty worktree (code AND any nested spec-store mount)
// before tearing it down, so a restart can never lose in-flight work.
//
//   node --test tests/supervisor/reconcile-worktrees.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeSupervisorEnv, makeSpecStore, git } from "./_data-helpers.mjs";

const env = makeSupervisorEnv("reconcile-wt-");
const { addWorktreeForBranch, reconcileWorktrees } = await import("../../tools/supervisor/lib/worktree.mjs");
const { mountCoupled, pruneAllCoupledWorktrees } = await import("../../tools/supervisor/lib/coupled-repos.mjs");
const { initLogStore } = await import("../../tools/supervisor/lib/log.mjs");
initLogStore(env.dataDir);

// addWorktreeForBranch hydrates node_modules into every worktree it
// creates — REPO needs one to copy from, or provisioning itself fails.
mkdirSync(join(env.repo, "node_modules"), { recursive: true });
writeFileSync(join(env.repo, "node_modules", ".keep"), "");

test("reconcileWorktrees: a CLEAN worktree is removed outright, no phantom commit", async () => {
  git(env.repo, ["branch", "bos/clean-branch"]);
  const wt = await addWorktreeForBranch("bos/clean-branch");
  const tipBefore = git(env.repo, ["rev-parse", "bos/clean-branch"]);

  await reconcileWorktrees();

  assert.equal(existsSync(wt), false, "the worktree directory must be gone");
  assert.equal(git(env.repo, ["rev-parse", "bos/clean-branch"]), tipBefore, "a clean worktree must not gain a spurious commit");
});

test("reconcileWorktrees: a DIRTY worktree is safety-committed before removal — the edit survives", async () => {
  git(env.repo, ["branch", "bos/dirty-branch"]);
  const wt = await addWorktreeForBranch("bos/dirty-branch");
  const tipBefore = git(env.repo, ["rev-parse", "bos/dirty-branch"]);

  // Simulate an agent's dev_delegate edit that never reached buildAndStart's
  // own commit step before the Supervisor restarted.
  writeFileSync(join(wt, "uncommitted-edit.txt"), "the agent's in-flight work\n");

  await reconcileWorktrees();

  assert.equal(existsSync(wt), false, "the worktree directory is still torn down");
  const tipAfter = git(env.repo, ["rev-parse", "bos/dirty-branch"]);
  assert.notEqual(tipAfter, tipBefore, "the branch must have gained a new, safety-net commit");

  // The edit must be recoverable: check the branch out fresh and confirm the file is there.
  const recovered = join(env.worktrees, "..", "recovered-dirty-branch");
  git(env.repo, ["worktree", "add", recovered, "bos/dirty-branch"]);
  assert.equal(existsSync(join(recovered, "uncommitted-edit.txt")), true, "the uncommitted edit must have been preserved by the safety-net commit");
  git(env.repo, ["worktree", "remove", "--force", recovered]);
});

test("reconcileWorktrees: uncommitted edits in a NESTED spec-store mount also survive", async () => {
  const specsRoot = join(env.dataDir, "specs");
  mkdirSync(specsRoot, { recursive: true });
  const storeRoot = makeSpecStore(specsRoot, "bos-system-specs", "master");
  const storeTipBefore = git(storeRoot, ["rev-parse", "master"]);

  git(env.repo, ["branch", "bos/spec-dirty-branch"]);
  const wt = await addWorktreeForBranch("bos/spec-dirty-branch");
  await mountCoupled({ id: "bos-system-specs", root: storeRoot, kind: "spec-store" }, join(wt, "specs", "bos-system-specs"), "bos/spec-dirty-branch");
  writeFileSync(join(wt, "specs", "bos-system-specs", "new-spec.md"), "# a spec the agent was writing\n");

  await reconcileWorktrees();
  // Real boot (main() in supervisor.mjs) always runs these two together —
  // reconcileWorktrees() only tears down the CODE worktree's directory; the
  // nested spec-store repo's OWN worktree registration (its `.git/worktrees/
  // <name>` metadata) is a separate leftover this pass cleans up.
  await pruneAllCoupledWorktrees();

  assert.equal(existsSync(wt), false);
  const storeTipAfter = git(storeRoot, ["rev-parse", "bos/spec-dirty-branch"]);
  assert.notEqual(storeTipAfter, storeTipBefore, "the spec store's feature branch must have gained a safety-net commit");

  const recovered = join(specsRoot, "..", "recovered-spec-branch");
  git(storeRoot, ["worktree", "add", recovered, "bos/spec-dirty-branch"]);
  assert.equal(existsSync(join(recovered, "new-spec.md")), true, "the uncommitted spec edit must have been preserved");
  git(storeRoot, ["worktree", "remove", "--force", recovered]);
});

test("reconcileWorktrees: never touches REPO itself", async () => {
  writeFileSync(join(env.repo, "dirty-in-repo.txt"), "must survive untouched\n");
  await reconcileWorktrees();
  assert.equal(existsSync(join(env.repo, "dirty-in-repo.txt")), true, "REPO's own working tree must never be reconciled/removed");
  git(env.repo, ["checkout", "--", "."]);
  git(env.repo, ["clean", "-fd"]);
});

test.after(() => env.cleanup());
