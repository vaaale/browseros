import { test } from "node:test";
import assert from "node:assert/strict";
import { git, makeRepoWithEnv } from "./_helpers.mjs";

test("pullBaseBeforeNewBranch is a no-op with no remote configured (no git-remotes.json)", async () => {
  const { repo, cleanup } = makeRepoWithEnv();
  try {
    const mod = await import("../../tools/supervisor/lib/preview.mjs");
    const { state } = await import("../../tools/supervisor/lib/state.mjs");
    state.baseBranch = git(repo, ["branch", "--show-current"]);
    await assert.doesNotReject(mod.pullBaseBeforeNewBranch());
  } finally {
    cleanup();
  }
});
