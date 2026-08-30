import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepoWithEnv } from "./_helpers.mjs";

test("firstSourceRemote returns null when no git-remotes.json exists at all", async () => {
  const { cleanup } = makeRepoWithEnv(); // sets BOS_REPO/BOS_CANONICAL_DATA before any config.mjs import happens
  try {
    const mod = await import("../../tools/supervisor/lib/preview.mjs");
    assert.equal(await mod.firstSourceRemote(), null);
  } finally {
    cleanup();
  }
});
