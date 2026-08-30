import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, makeRepoWithEnv } from "./_helpers.mjs";

test("pullBaseBeforeNewBranch fetches and fast-forwards the base branch from the configured remote before a new branch would be cut", async () => {
  const { repo, dataDir, cleanup } = makeRepoWithEnv();
  try {
    const baseBranch = git(repo, ["branch", "--show-current"]);

    const bareDir = mkdtempSync(join(tmpdir(), "supervisor-pull-remote-"));
    git(bareDir, ["init", "-q", "--bare"]);
    git(repo, ["remote", "add", "origin", bareDir]);
    git(repo, ["push", "origin", baseBranch]);

    const otherClone = mkdtempSync(join(tmpdir(), "supervisor-pull-other-clone-"));
    git(tmpdir(), ["clone", "-q", bareDir, otherClone]);
    writeFileSync(join(otherClone, "upstream.md"), "new upstream commit\n");
    git(otherClone, ["add", "-A"]);
    git(otherClone, ["commit", "-q", "-m", "upstream change"]);
    git(otherClone, ["push", "origin", baseBranch]);

    mkdirSync(join(dataDir, "config"), { recursive: true });
    writeFileSync(join(dataDir, "config", "git-remotes.json"), JSON.stringify([{ name: "origin", url: bareDir }]));

    const mod = await import("../../tools/supervisor/lib/preview.mjs");
    const { state } = await import("../../tools/supervisor/lib/state.mjs");
    state.baseBranch = baseBranch;

    assert.equal(existsSync(join(repo, "upstream.md")), false);
    await mod.pullBaseBeforeNewBranch();
    assert.equal(existsSync(join(repo, "upstream.md")), true);

    rmSync(bareDir, { recursive: true, force: true });
    rmSync(otherClone, { recursive: true, force: true });
  } finally {
    cleanup();
  }
});
