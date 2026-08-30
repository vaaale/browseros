import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepoWithEnv } from "./_helpers.mjs";

test("firstSourceRemote finds an untagged (legacy) or bos-src-tagged remote, ignoring remotes for other filesystems", async () => {
  const { dataDir, cleanup } = makeRepoWithEnv();
  try {
    mkdirSync(join(dataDir, "config"), { recursive: true });
    writeFileSync(
      join(dataDir, "config", "git-remotes.json"),
      JSON.stringify([
        { name: "spec-origin", url: "/tmp/x", filesystem: "user-specs" },
        { name: "origin", url: "/tmp/y" }, // legacy/untagged => belongs to the BrowserOS source repo
      ]),
    );
    const mod = await import("../../tools/supervisor/lib/preview.mjs");
    const remote = await mod.firstSourceRemote();
    assert.equal(remote?.name, "origin");
  } finally {
    cleanup();
  }
});
