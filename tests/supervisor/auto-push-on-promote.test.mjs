// Verifies the Supervisor's auto-push-on-promote mechanism actually pushes
// (037-project-layer, Phase 7 — this was asked to be verified, not rebuilt;
// it turned out to already be fully wired, this test proves it end to end).
// Own process (see _helpers.mjs's header comment on why): config.mjs reads
// BOS_CANONICAL_DATA at module load time.
//   node --test tests/supervisor/auto-push-on-promote.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, makeRepoWithEnv } from "./_helpers.mjs";

test("runAutoPush pushes to every autoPush-enabled, non-origin configured remote and skips the rest", async () => {
  const { repo, dataDir, cleanup } = makeRepoWithEnv();
  try {
    const branch = git(repo, ["branch", "--show-current"]);

    const enabledRemoteDir = mkdtempSync(join(tmpdir(), "auto-push-enabled-"));
    git(enabledRemoteDir, ["init", "-q", "--bare"]);
    const disabledRemoteDir = mkdtempSync(join(tmpdir(), "auto-push-disabled-"));
    git(disabledRemoteDir, ["init", "-q", "--bare"]);
    const originRemoteDir = mkdtempSync(join(tmpdir(), "auto-push-origin-"));
    git(originRemoteDir, ["init", "-q", "--bare"]);

    mkdirSync(join(dataDir, "config"), { recursive: true });
    writeFileSync(
      join(dataDir, "config", "git-remotes.json"),
      JSON.stringify([
        { name: "mirror", url: enabledRemoteDir, autoPush: true },
        { name: "backup", url: disabledRemoteDir, autoPush: false },
        // Named "origin" — excluded even though autoPush is true; origin's
        // own push is a separate, explicitly-gated path (BOS_PUSH_MODE).
        { name: "origin", url: originRemoteDir, autoPush: true },
      ]),
    );
    git(repo, ["remote", "add", "mirror", enabledRemoteDir]);
    git(repo, ["remote", "add", "backup", disabledRemoteDir]);
    git(repo, ["remote", "add", "origin", originRemoteDir]);

    const mod = await import("../../tools/supervisor/lib/push.mjs");
    const results = await mod.runAutoPush(repo, branch);

    assert.deepEqual(results, [{ remoteName: "mirror", status: "success" }]);

    const mirrorBranches = git(enabledRemoteDir, ["branch", "--list", branch]);
    assert.match(mirrorBranches, new RegExp(branch));
    const backupBranches = git(disabledRemoteDir, ["branch", "--list", branch]);
    assert.equal(backupBranches, "");
    const originBranches = git(originRemoteDir, ["branch", "--list", branch]);
    assert.equal(originBranches, "");

    rmSync(enabledRemoteDir, { recursive: true, force: true });
    rmSync(disabledRemoteDir, { recursive: true, force: true });
    rmSync(originRemoteDir, { recursive: true, force: true });
  } finally {
    cleanup();
  }
});

test("runAutoPush returns an empty list when no git-remotes.json exists", async () => {
  const { repo, cleanup } = makeRepoWithEnv();
  try {
    const branch = git(repo, ["branch", "--show-current"]);
    const mod = await import("../../tools/supervisor/lib/push.mjs");
    assert.deepEqual(await mod.runAutoPush(repo, branch), []);
  } finally {
    cleanup();
  }
});
