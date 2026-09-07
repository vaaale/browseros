// Unit test for the credential-building branch of
// tools/supervisor/lib/push.mjs's runAutoPush, not already covered by
// auto-push-on-promote.test.mjs (which only exercises unauthenticated
// remotes). Own process — see _helpers.mjs's header comment (config.mjs
// freezes BOS_CANONICAL_DATA at first import; a second scenario needing a
// DIFFERENT dataDir belongs in its own file/process, see
// push-autopush-failure.test.mjs).
//   node --test tests/supervisor/push-autopush-credentials.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, makeRepoWithEnv } from "./_helpers.mjs";

test("runAutoPush: a token-authenticated remote resolves and applies its stored credential", async () => {
  const { repo, dataDir, cleanup } = makeRepoWithEnv();
  try {
    const branch = git(repo, ["branch", "--show-current"]);
    writeFileSync(join(dataDir, ".integrations-key"), randomBytes(32));

    const remoteDir = mkdtempSync(join(tmpdir(), "autopush-token-remote-"));
    git(remoteDir, ["init", "-q", "--bare"]);
    mkdirSync(join(dataDir, "config"), { recursive: true });
    writeFileSync(
      join(dataDir, "config", "git-remotes.json"),
      JSON.stringify([{ name: "origin", url: remoteDir, autoPush: true, filesystem: "bos-src", authType: "token" }]),
    );
    git(repo, ["remote", "add", "origin", remoteDir]);

    const { setEncrypted } = await import("../../tools/supervisor/lib/secrets.mjs");
    setEncrypted(dataDir, "git_remote:token:origin", { token: "does-not-matter-locally" });

    const { runAutoPush } = await import("../../tools/supervisor/lib/push.mjs");
    const results = await runAutoPush(repo, branch, "bos-src");

    assert.deepEqual(results, [{ remoteName: "origin", status: "success" }]);
    assert.equal(git(remoteDir, ["rev-parse", branch]), git(repo, ["rev-parse", "HEAD"]));

    rmSync(remoteDir, { recursive: true, force: true });
  } finally {
    cleanup();
  }
});
