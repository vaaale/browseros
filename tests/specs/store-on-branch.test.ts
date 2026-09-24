// REPRODUCTION: "the branch is showing for all repos in the BS tree except for
// the user-apps."
//
// Build Studio paints a branch badge on every store header whose owner is
// "user" (index.tsx, `group.owner === "user"`), and the value it paints is the
// conversation's active branch — CLIENT state, never anything the server said
// about that store:
//
//     {group.owner === "user" && <span ...>{userBranch || "no branch selected"}</span>}
//
// It was right when written: user-specs was the only owner:"user" store, and
// user-specs is coupled to every bos-core branch. 050 made an arbitrary
// registered repository a store with owner:"user" as well, so `police-mcp` now
// shows "bos/testfixture-agentic-editor-v4 — Editable on this branch" for a
// branch that does not exist in it and never will.
//
// Which is why every server-side check passed while the screen stayed wrong:
// the badge asks the server nothing. The fix is for the server to answer
// per-store — `liveBranch` already does it for item stores — and for the header
// to render that instead of guessing from one global.
//
//   npm run test:unit -- tests/specs/store-on-branch.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { readFileSync, mkdirSync, writeFileSync, symlinkSync } from "fs";
import { execFileSync } from "child_process";
import { useTestDataDir } from "../services/_test-env";
import { specTree } from "../../src/lib/specs/pipeline";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
}

/** user-specs, plus a registered repository (050) — the two stores that both
 *  report owner "user" and are branched under completely different conditions. */
function layOutStores(dataDir: string): void {
  const specs = join(dataDir, "specs");
  for (const id of ["user-specs", "police-mcp"]) {
    const root = join(specs, id);
    mkdirSync(root, { recursive: true });
    git(root, ["init", "-q", "-b", "master"]);
    writeFileSync(join(root, "spec-store.json"), JSON.stringify({ id }, null, 2));
    writeFileSync(join(root, "README.md"), `${id}\n`);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "init"]);
  }
  const apps = join(dataDir, "user-apps");
  mkdirSync(join(apps, "items", "agentic-text-editor", "spec"), { recursive: true });
  git(apps, ["init", "-q", "-b", "master"]);
  writeFileSync(join(apps, "marketplace.json"), JSON.stringify({ items: [] }, null, 2));
  writeFileSync(join(apps, "items", "agentic-text-editor", "spec", "spec.md"), "# editor\n");
  mkdirSync(join(dataDir, "system"), { recursive: true });
  symlinkSync(join(apps, "items", "agentic-text-editor"), join(dataDir, "system", "agentic-text-editor"));
  git(apps, ["add", "-A"]);
  git(apps, ["commit", "-q", "-m", "items"]);
}

function scope(dataDir: string, branch: string, s: unknown): void {
  mkdirSync(join(dataDir, "system"), { recursive: true });
  writeFileSync(join(dataDir, "system", "branch-scopes.json"), JSON.stringify({ [branch]: s }, null, 2));
}

/** Which store headers the sidebar should show the branch on. */
function onBranch(tree: Awaited<ReturnType<typeof specTree>>): string[] {
  return tree.filter((g) => g.liveBranch).map((g) => g.path).sort();
}

test("a marketplace branch is on the ITEM — not user-specs, not a registered repo", async () => {
  const { dir: dataDir, cleanup } = useTestDataDir("store-on-branch");
  try {
    layOutStores(dataDir);
    const branch = "bos/testfixture-agentic-editor-v4";
    scope(dataDir, branch, { kind: "marketplace-item", itemId: "agentic-text-editor" });
    expect(onBranch(await specTree(branch))).toEqual(["item-agentic-text-editor"]);
  } finally {
    cleanup();
  }
});

test("a bos-core branch is on user-specs — and NOT on a registered repository", async () => {
  const { dir: dataDir, cleanup } = useTestDataDir("store-on-branch");
  try {
    layOutStores(dataDir);
    const branch = "bos/testfixture-core-change";
    scope(dataDir, branch, { kind: "bos-core" });
    // user-specs IS coupled to a bos-core branch, so its header legitimately
    // shows it. police-mcp is not, and showing it there is the reported bug.
    expect(onBranch(await specTree(branch))).toEqual(["user-specs"]);
  } finally {
    cleanup();
  }
});

test("a repository branch is on THAT repository only", async () => {
  const { dir: dataDir, cleanup } = useTestDataDir("store-on-branch");
  try {
    layOutStores(dataDir);
    const branch = "bos/testfixture-police-work";
    scope(dataDir, branch, { kind: "repository", repoId: "police-mcp" });
    expect(onBranch(await specTree(branch))).toEqual(["police-mcp"]);
  } finally {
    cleanup();
  }
});

test("the sidebar renders the SERVER's per-store answer, not one global branch", async () => {
  // The badge is client-side and not reachable from this suite, so assert the
  // shape of the code instead: `group.owner === "user" && ... {userBranch}` is
  // the bug itself — a header cannot decide from a global whether ITS store is
  // on the branch, and every server-side test passed while it was wrong.
  const src = readFileSync("src/apps/build-studio/index.tsx", "utf8");
  const badge = src.slice(src.indexOf('data-testid="user-specs-branch-badge"'));
  const block = badge.slice(0, badge.indexOf("</span>"));
  expect(block, "the store-header branch badge must render group.liveBranch").toContain("liveBranch");
});
