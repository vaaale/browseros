// REPRODUCTION: "the branch is showing for all repos in the BS tree".
//
// Every marketplace item lives in the SAME `user-apps` repository. Once that
// repo is coupled to a feature branch, "this store is on branch X" is literally
// true of every item in it — so a row that reports the branch it was read
// through reports it on all of them at once. Eleven items, eleven badges, for a
// change that concerns exactly one.
//
// The scope already records which item the branch is FOR
// (`{ kind: "marketplace-item", itemId: "agentic-text-editor" }`). Nothing read
// it, so the tree could not tell the item being worked on from its ten
// neighbours.
//   npm run test:unit -- tests/specs/item-store-branch-badge.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync, symlinkSync } from "fs";
import { execFileSync } from "child_process";
import { useTestDataDir } from "../services/_test-env";
import { specTree } from "../../src/lib/specs/pipeline";
import type { SpecTreeNode } from "../../src/lib/specs/types";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** An installed local item with a spec facet — the 035 symlink is what makes it
 *  installed, and item-stores.ts is what turns it into a store. */
function installItem(dataDir: string, id: string): void {
  const itemPath = join(dataDir, "user-apps", "items", id);
  mkdirSync(join(itemPath, "spec"), { recursive: true });
  writeFileSync(join(itemPath, "spec", "spec.md"), `# ${id}\n\nA spec for ${id}.\n`);
  mkdirSync(join(dataDir, "system"), { recursive: true });
  symlinkSync(itemPath, join(dataDir, "system", id));
}

function scope(dataDir: string, branch: string, s: unknown): void {
  mkdirSync(join(dataDir, "system"), { recursive: true });
  writeFileSync(join(dataDir, "system", "branch-scopes.json"), JSON.stringify({ [branch]: s }, null, 2));
}

function rowsWithLiveBranch(tree: SpecTreeNode[]): string[] {
  return tree.filter((g) => g.liveBranch).map((g) => g.path).sort();
}

test("a marketplace branch badges the item it is FOR — not every item sharing the repo", async () => {
  const { dir: dataDir, cleanup } = useTestDataDir("item-branch-badge");
  try {
    const apps = join(dataDir, "user-apps");
    mkdirSync(apps, { recursive: true });
    git(apps, ["init", "-q", "-b", "master"]);
    writeFileSync(join(apps, "marketplace.json"), JSON.stringify({ items: [] }, null, 2));
    for (const id of ["agentic-text-editor", "lunar-lander", "terminal"]) installItem(dataDir, id);
    git(apps, ["add", "-A"]);
    git(apps, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "items"]);

    const branch = "bos/testfixture-agentic-editor-appearance";
    scope(dataDir, branch, { kind: "marketplace-item", itemId: "agentic-text-editor" });

    const tree = await specTree(branch);
    const badged = rowsWithLiveBranch(tree);

    expect(badged, "only the item the branch is scoped to carries the branch").toEqual([
      "item-agentic-text-editor",
    ]);

    // The row the user is working in must still SAY the branch — the whole point
    // of the badge is that a marketplace change branches user-apps and nothing
    // else, so this is the only row that can report it at all.
    const worked = tree.find((g) => g.path === "item-agentic-text-editor");
    expect(worked?.liveBranch).toBe(branch);
    // ...and it is carried on the synthetic row too, which is what the sidebar
    // actually draws (item groups are flattened under one "User Apps" heading).
    expect(worked?.children?.[0]?.liveBranch).toBe(branch);
  } finally {
    cleanup();
  }
});

test("a bos-core branch badges no item at all", async () => {
  const { dir: dataDir, cleanup } = useTestDataDir("item-branch-badge");
  try {
    const apps = join(dataDir, "user-apps");
    mkdirSync(apps, { recursive: true });
    git(apps, ["init", "-q", "-b", "master"]);
    writeFileSync(join(apps, "marketplace.json"), JSON.stringify({ items: [] }, null, 2));
    installItem(dataDir, "lunar-lander");
    git(apps, ["add", "-A"]);
    git(apps, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "items"]);

    // BOS's own source + user-specs. user-apps is not coupled, so no item is on
    // this branch and claiming otherwise is simply false.
    scope(dataDir, "bos/testfixture-core-change", { kind: "bos-core" });
    expect(rowsWithLiveBranch(await specTree("bos/testfixture-core-change"))).toEqual([]);
  } finally {
    cleanup();
  }
});

test("an UNSCOPED branch does not pretend to know which item it is for", async () => {
  const { dir: dataDir, cleanup } = useTestDataDir("item-branch-badge");
  try {
    const apps = join(dataDir, "user-apps");
    mkdirSync(apps, { recursive: true });
    git(apps, ["init", "-q", "-b", "master"]);
    writeFileSync(join(apps, "marketplace.json"), JSON.stringify({ items: [] }, null, 2));
    for (const id of ["lunar-lander", "terminal"]) installItem(dataDir, id);
    git(apps, ["add", "-A"]);
    git(apps, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "items"]);

    // No scope recorded. user-apps IS coupled under the unscoped fallback, so
    // every item is genuinely on the branch and none is distinguishable — badging
    // all of them is the noise this test exists to prevent, and badging one would
    // be a guess. Say nothing.
    scope(dataDir, "bos/testfixture-other", { kind: "bos-core" });
    expect(rowsWithLiveBranch(await specTree("bos/testfixture-legacy-no-scope"))).toEqual([]);
  } finally {
    cleanup();
  }
});
