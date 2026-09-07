// Unit test for tools/supervisor/lib/push.mjs's runAutoPush: one remote's
// push failure is recorded into the results, never thrown, and must not
// stop the other configured remotes' pushes. Own process — see
// push-autopush-credentials.test.mjs's header comment on why this is a
// separate file.
//   node --test tests/supervisor/push-autopush-failure.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, makeRepoWithEnv } from "./_helpers.mjs";

test("runAutoPush: one remote's push failure is recorded, not thrown, and does not stop the others", async () => {
  const { repo, dataDir, cleanup } = makeRepoWithEnv();
  try {
    const branch = git(repo, ["branch", "--show-current"]);

    const goodRemoteDir = mkdtempSync(join(tmpdir(), "autopush-good-remote-"));
    git(goodRemoteDir, ["init", "-q", "--bare"]);
    const badRemoteDir = join(tmpdir(), "autopush-nonexistent-remote-does-not-exist");

    mkdirSync(join(dataDir, "config"), { recursive: true });
    writeFileSync(
      join(dataDir, "config", "git-remotes.json"),
      JSON.stringify([
        { name: "good", url: goodRemoteDir, autoPush: true, filesystem: "bos-src" },
        { name: "bad", url: badRemoteDir, autoPush: true, filesystem: "bos-src" },
      ]),
    );
    git(repo, ["remote", "add", "good", goodRemoteDir]);
    git(repo, ["remote", "add", "bad", badRemoteDir]);

    const { runAutoPush } = await import("../../tools/supervisor/lib/push.mjs");
    const results = await runAutoPush(repo, branch, "bos-src");

    const byName = Object.fromEntries(results.map((r) => [r.remoteName, r]));
    assert.equal(byName.good?.status, "success");
    assert.equal(byName.bad?.status, "failed");
    assert.ok(byName.bad?.error, "the failure reason must be recorded");
    assert.equal(git(goodRemoteDir, ["rev-parse", branch]), git(repo, ["rev-parse", "HEAD"]), "the good remote must still have received the push");

    rmSync(goodRemoteDir, { recursive: true, force: true });
  } finally {
    cleanup();
  }
});
