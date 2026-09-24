// REPRODUCTION: "the agent created a feature branch in all repositories".
//
// Reported three times. Each previous fix was made by reading the code and
// reasoning about which list a caller used — and each time the branch still
// appeared in every repository, because the reasoning was about a function that
// was not the one creating it.
//
// So this file does not test a function. It drives the REAL entry points the
// `/begin` route drives, against real git repositories, and then asks git
// itself, in each repository, whether the branch is there. Nothing is stubbed:
// if the product creates a branch in police-mcp, this test sees it.
//
// The fixture is the user's actual layout:
//   browseros          BOS's own source                 (branch EXPECTED)
//   user-apps          the marketplace                  (branch EXPECTED)
//   user-specs         BOS's user spec store            (branch NOT expected)
//   bos-system-specs   read-only, owner "system"        (branch NOT expected)
//   police-mcp         a registered repo, 050, unrelated (branch NOT expected)
//
//   node --test tests/supervisor/branch-creation-repro.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeSupervisorEnv, makeSpecStore, git } from "./_data-helpers.mjs";

const env = makeSupervisorEnv("branch-repro-");
mkdirSync(join(env.repo, "node_modules"), { recursive: true });
writeFileSync(join(env.repo, "node_modules", ".keep"), "");

const specsRoot = join(env.dataDir, "specs");
mkdirSync(specsRoot, { recursive: true });

/** A spec store with an explicit manifest — `owner`/`writable` are what decide
 *  whether a store may EVER be branched. */
function store(id, manifest = {}) {
  const root = makeSpecStore(specsRoot, id);
  writeFileSync(join(root, "spec-store.json"), JSON.stringify({ id, ...manifest }, null, 2));
  git(root, ["add", "-A"]);
  // makeSpecStore already committed `{id}`, so a store with no extra manifest
  // fields has nothing to commit here and `git commit` exits 1.
  if (git(root, ["status", "--porcelain"])) git(root, ["commit", "-q", "-m", "manifest"]);
  return root;
}

const REPOS = {
  "user-specs": store("user-specs"),
  "bos-system-specs": store("bos-system-specs", { owner: "system", writable: false }),
  "police-mcp": store("police-mcp"),
};

// user-apps is not a spec store — it is the marketplace, mounted from the data
// dir. ensureAppsRepo() creates it on first mount; create it up front so the
// "does it have the branch" check below is asking a real repository either way.
const APPS = join(env.dataDir, "user-apps");
mkdirSync(APPS, { recursive: true });
git(APPS, ["init", "-q", "-b", "master"]);
writeFileSync(join(APPS, "marketplace.json"), JSON.stringify({ items: [] }, null, 2));
git(APPS, ["add", "-A"]);
git(APPS, ["commit", "-q", "-m", "init"]);
REPOS["user-apps"] = APPS;
REPOS["browseros"] = env.repo;

function scope(branch, s) {
  const dir = join(env.dataDir, "system");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "branch-scopes.json"), JSON.stringify({ [branch]: s }, null, 2));
}

/** Ask git, in every repository, whether the branch exists. This is the whole
 *  point of the file: the assertion is made against git, not against the return
 *  value of the function under test — a function can return the right list and
 *  the branch can still be somewhere else. */
function reposWithBranch(branch) {
  return Object.entries(REPOS)
    .filter(([, root]) => {
      try {
        git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
        return true;
      } catch {
        return false;
      }
    })
    .map(([id]) => id)
    .sort();
}

const { provisionPreview, beginPreview, buildPreview } = await import("../../tools/supervisor/lib/preview.mjs");
const { promote } = await import("../../tools/supervisor/lib/promote.mjs");
const { reconcileWorktrees } = await import("../../tools/supervisor/lib/worktree.mjs");
const { state, previews } = await import("../../tools/supervisor/lib/state.mjs");
const { initLogStore, getLogStore } = await import("../../tools/supervisor/lib/log.mjs");
initLogStore(env.dataDir);
await getLogStore()._ready;
state.baseBranch = env.baseBranch;

test("THE REPORTED BUG: a marketplace change branches user-apps and BOS's source, and nothing else", async () => {
  const branch = "bos/testfixture-agentic-editor-background";
  scope(branch, { kind: "marketplace-item", itemId: "agentic-text-editor" });
  try {
    // Exactly what /begin does, in order. beginPreview is the call that mounts,
    // and mounting is what runs `git worktree add -b` — i.e. what CREATES the
    // branch in a coupled repository.
    await provisionPreview(branch);
    await beginPreview(branch);

    assert.deepEqual(
      reposWithBranch(branch),
      ["browseros", "user-apps"],
      "a marketplace change must not branch user-specs, the read-only system store, or the user's unrelated police-mcp",
    );
  } finally {
    previews.delete(branch);
  }
});

test("BOS core: BOS's source and user-specs — not the marketplace, not a registered repo", async () => {
  const branch = "bos/testfixture-core-change";
  scope(branch, { kind: "bos-core" });
  try {
    await provisionPreview(branch);
    await beginPreview(branch);
    assert.deepEqual(reposWithBranch(branch), ["browseros", "user-specs"]);
  } finally {
    previews.delete(branch);
  }
});

test("a registered repository is nobody's business but its own", async () => {
  const branch = "bos/testfixture-police-work";
  scope(branch, { kind: "repository", repoId: "police-mcp" });
  try {
    await provisionPreview(branch);
    await beginPreview(branch);
    // BOS's own source is always branched — that is where the preview runs.
    assert.deepEqual(reposWithBranch(branch), ["browseros", "police-mcp"]);
  } finally {
    previews.delete(branch);
  }
});

test("the read-only system store is never branched, under any scope", async () => {
  // It is documented read-only and was getting bos/* branches anyway. Asserted
  // across every scope at once so a new scope kind cannot quietly omit it.
  const seen = [];
  for (const [i, s] of [
    { kind: "marketplace-item" },
    { kind: "bos-core" },
    { kind: "repository", repoId: "police-mcp" },
    null,
  ].entries()) {
    const branch = `bos/system-store-guard-${i}`;
    if (s) scope(branch, s);
    else writeFileSync(join(env.dataDir, "system", "branch-scopes.json"), "{}");
    try {
      await provisionPreview(branch);
      await beginPreview(branch);
      if (reposWithBranch(branch).includes("bos-system-specs")) seen.push(s ? s.kind : "unscoped");
    } finally {
      previews.delete(branch);
    }
  }
  assert.deepEqual(seen, [], "bos-system-specs is read-only and must never receive a bos/* branch");
});

// ── The stages AFTER begin ───────────────────────────────────────────────────
//
// Every test above stops at beginPreview, and so did every check I made against
// the live system: the reported runs got as far as build and promote, mine did
// not. A stage that couples repositories correctly at mount time can still cut
// a branch somewhere else later, and nothing here would have noticed.
test("BUILD does not widen the set of repositories holding the branch", async () => {
  const branch = "bos/testfixture-build-stage";
  scope(branch, { kind: "marketplace-item", itemId: "agentic-text-editor" });
  try {
    await provisionPreview(branch);
    await beginPreview(branch);
    const afterBegin = reposWithBranch(branch);
    await buildPreview(branch);
    assert.deepEqual(reposWithBranch(branch), afterBegin, `build added repositories: was ${afterBegin.join(", ")}`);
    assert.deepEqual(afterBegin, ["browseros", "user-apps"]);
  } finally {
    previews.delete(branch);
  }
});

// NOT COVERED HERE: promote. Reaching it needs a preview that passes the health
// gate, and the fake server the suite uses for that leaves this runner hanging.
// Stated rather than silently omitted — promote is the one stage of a real run
// this file does not exercise, and the reported fault has not been ruled out
// there.

test("a Supervisor RESTART does not re-create the branch in every store", async () => {
  // restorePreviews/reconcileWorktrees run at boot over whatever bos/* branches
  // exist. They mount, and mounting is what cuts a branch.
  const branch = "bos/testfixture-restart-stage";
  scope(branch, { kind: "marketplace-item", itemId: "agentic-text-editor" });
  try {
    await provisionPreview(branch);
    await beginPreview(branch);
    const before = reposWithBranch(branch);
    await reconcileWorktrees();
    assert.deepEqual(reposWithBranch(branch), before, "reconcile widened the branch set");
  } finally {
    previews.delete(branch);
  }
});

test.after(() => env.cleanup());
