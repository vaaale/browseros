import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, makeRepoWithEnv } from "./_helpers.mjs";

// Refreshing the base before cutting a new branch is BEST-EFFORT.
//
// It used to throw, and that made an unreachable remote — or an expired OAuth
// token — block work that touches no network at all. The observed report:
// creating a FOLDER in a spec store needs the branch's worktree, creating the
// branch triggered this fetch, and the user got "No usable OAuth credential for
// provider gitlab" from an entirely local operation.
//
// Starting from an up-to-date base makes the eventual promote easier; it is not
// a correctness requirement, and git reports divergence at merge time anyway. So
// the failure is REPORTED and the branch is cut from the local base.
test("an unreachable remote does not block cutting a branch — the reason is returned, not thrown", async () => {
  const { repo, dataDir, cleanup } = makeRepoWithEnv();
  try {
    const baseBranch = git(repo, ["branch", "--show-current"]);
    const headBefore = git(repo, ["rev-parse", "HEAD"]);

    // A remote that cannot possibly be reached, configured the way a real one is.
    mkdirSync(join(dataDir, "config"), { recursive: true });
    writeFileSync(
      join(dataDir, "config", "git-remotes.json"),
      JSON.stringify([{ name: "origin", url: join(dataDir, "no-such-repo.git") }]),
    );
    git(repo, ["remote", "add", "origin", join(dataDir, "no-such-repo.git")]);

    const mod = await import("../../tools/supervisor/lib/preview.mjs");
    const { state } = await import("../../tools/supervisor/lib/state.mjs");
    state.baseBranch = baseBranch;

    const warning = await mod.pullBaseBeforeNewBranch();

    // Returned, not thrown: the caller carries on and cuts the branch.
    assert.ok(warning, "the failure must be reported, not swallowed");
    assert.equal(typeof warning, "string");
    // And the repo is untouched — no half-applied merge left behind.
    assert.equal(git(repo, ["rev-parse", "HEAD"]), headBefore);
  } finally {
    cleanup();
  }
});

test("no remote configured is not a failure, and reports nothing", async () => {
  // A fresh BOS with no remote must not be told its base is stale — there is
  // nothing to be stale against.
  const { repo, cleanup } = makeRepoWithEnv();
  try {
    const mod = await import("../../tools/supervisor/lib/preview.mjs");
    const { state } = await import("../../tools/supervisor/lib/state.mjs");
    state.baseBranch = git(repo, ["branch", "--show-current"]);
    assert.equal(await mod.pullBaseBeforeNewBranch(), null);
  } finally {
    cleanup();
  }
});
