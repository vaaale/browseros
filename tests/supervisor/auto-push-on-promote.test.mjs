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

test("runAutoPush pushes every autoPush-enabled remote scoped to the given filesystem — INCLUDING one literally named 'origin' — and skips the rest", async () => {
  const { repo, dataDir, cleanup } = makeRepoWithEnv();
  try {
    const branch = git(repo, ["branch", "--show-current"]);

    const enabledRemoteDir = mkdtempSync(join(tmpdir(), "auto-push-enabled-"));
    git(enabledRemoteDir, ["init", "-q", "--bare"]);
    const disabledRemoteDir = mkdtempSync(join(tmpdir(), "auto-push-disabled-"));
    git(disabledRemoteDir, ["init", "-q", "--bare"]);
    const originRemoteDir = mkdtempSync(join(tmpdir(), "auto-push-origin-"));
    git(originRemoteDir, ["init", "-q", "--bare"]);
    const legacyRemoteDir = mkdtempSync(join(tmpdir(), "auto-push-legacy-"));
    git(legacyRemoteDir, ["init", "-q", "--bare"]);
    const otherFsRemoteDir = mkdtempSync(join(tmpdir(), "auto-push-other-fs-"));
    git(otherFsRemoteDir, ["init", "-q", "--bare"]);

    mkdirSync(join(dataDir, "config"), { recursive: true });
    writeFileSync(
      join(dataDir, "config", "git-remotes.json"),
      JSON.stringify([
        { name: "mirror", url: enabledRemoteDir, autoPush: true, filesystem: "bos-src" },
        { name: "backup", url: disabledRemoteDir, autoPush: false, filesystem: "bos-src" },
        // Every real remote in a typical deployment is conventionally named
        // "origin" (one push target per repo) — this regression-tests the
        // actual production bug: a remote must never be excluded by NAME,
        // only scoped by filesystem.
        { name: "origin", url: originRemoteDir, autoPush: true, filesystem: "bos-src" },
        // No `filesystem` tag at all — a legacy config, which belongs to the
        // BOS source checkout by default (mirrors belongsToFilesystem in
        // src/app/api/git-remotes/route.ts).
        { name: "legacy", url: legacyRemoteDir, autoPush: true },
        // autoPush is true but this remote belongs to a DIFFERENT filesystem
        // — must be skipped even though the flag is on.
        { name: "other-fs", url: otherFsRemoteDir, autoPush: true, filesystem: "user-apps" },
      ]),
    );
    git(repo, ["remote", "add", "mirror", enabledRemoteDir]);
    git(repo, ["remote", "add", "backup", disabledRemoteDir]);
    git(repo, ["remote", "add", "origin", originRemoteDir]);
    git(repo, ["remote", "add", "legacy", legacyRemoteDir]);
    git(repo, ["remote", "add", "other-fs", otherFsRemoteDir]);

    const mod = await import("../../tools/supervisor/lib/push.mjs");
    const results = await mod.runAutoPush(repo, branch, "bos-src");

    assert.deepEqual(
      results.sort((a, b) => a.remoteName.localeCompare(b.remoteName)),
      [
        { remoteName: "legacy", status: "success" },
        { remoteName: "mirror", status: "success" },
        { remoteName: "origin", status: "success" },
      ],
    );

    const mirrorBranches = git(enabledRemoteDir, ["branch", "--list", branch]);
    assert.match(mirrorBranches, new RegExp(branch));
    const originBranches = git(originRemoteDir, ["branch", "--list", branch]);
    assert.match(originBranches, new RegExp(branch), "a remote literally named 'origin' must still be pushed — the fix this test guards");
    const legacyBranches = git(legacyRemoteDir, ["branch", "--list", branch]);
    assert.match(legacyBranches, new RegExp(branch));
    const backupBranches = git(disabledRemoteDir, ["branch", "--list", branch]);
    assert.equal(backupBranches, "");
    const otherFsBranches = git(otherFsRemoteDir, ["branch", "--list", branch]);
    assert.equal(otherFsBranches, "", "a remote scoped to a different filesystem must not be pushed even with autoPush true");

    rmSync(enabledRemoteDir, { recursive: true, force: true });
    rmSync(disabledRemoteDir, { recursive: true, force: true });
    rmSync(originRemoteDir, { recursive: true, force: true });
    rmSync(legacyRemoteDir, { recursive: true, force: true });
    rmSync(otherFsRemoteDir, { recursive: true, force: true });
  } finally {
    cleanup();
  }
});

test("runAutoPush returns an empty list when no git-remotes.json exists", async () => {
  const { repo, cleanup } = makeRepoWithEnv();
  try {
    const branch = git(repo, ["branch", "--show-current"]);
    const mod = await import("../../tools/supervisor/lib/push.mjs");
    assert.deepEqual(await mod.runAutoPush(repo, branch, "bos-src"), []);
  } finally {
    cleanup();
  }
});
