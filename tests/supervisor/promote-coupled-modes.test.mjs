// The merge/mount logic, per branch-scope mode — a review of promote and the
// preview build rather than a report of a failure seen in the wild.
//
// Three things this pins down, each of which is wrong today:
//
//  1. `coupledMergeTarget` falls back to the LITERAL string "master" whenever a
//     repo's HEAD is not a symbolic ref. The user's own `user-apps` has no
//     master — its default is `main` — so that fallback names a branch that does
//     not exist. It is used both to pick the base a new coupled branch is CUT
//     FROM (mountCoupled) and the branch a promote MERGES INTO (promoteCoupled).
//
//  2. The branch scope is read from `cand.dataDir` — the preview's data clone —
//     which `provisionClone` snapshots ONCE from canonical data and then never
//     refreshes (it returns early if the clone exists, deliberately, so a
//     preview's own data survives restarts). Re-scoping a branch therefore never
//     takes effect, and a clone older than the scope silently falls back to
//     "unscoped": for a `repository`-scoped branch that means the one repo
//     holding the work is not in the promote set at all, and `promoteCoupled`
//     skips every repo it IS given because none of them has the branch. The work
//     is stranded on a branch nobody merges, silently.
//
//  3. `clearBranchScope` exists and is called by nothing, so every branch ever
//     created keeps an entry forever, and a REUSED branch name inherits the old
//     scope.
//
//   node --test tests/supervisor/promote-coupled-modes.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { makeSupervisorEnv, makeSpecStore, git } from "./_data-helpers.mjs";

const env = makeSupervisorEnv("promote-modes-");
mkdirSync(join(env.repo, "node_modules"), { recursive: true });
writeFileSync(join(env.repo, "node_modules", ".keep"), "");

const specsRoot = join(env.dataDir, "specs");
mkdirSync(specsRoot, { recursive: true });

function store(id, manifest = {}, defaultBranch = "master") {
  const root = makeSpecStore(specsRoot, id, defaultBranch);
  writeFileSync(join(root, "spec-store.json"), JSON.stringify({ id, ...manifest }, null, 2));
  git(root, ["add", "-A"]);
  if (git(root, ["status", "--porcelain"])) git(root, ["commit", "-q", "-m", "manifest"]);
  return root;
}

store("user-specs");
store("police-mcp");

// user-apps on `main`, with NO master — exactly the user's layout.
const APPS = join(env.dataDir, "user-apps");
mkdirSync(APPS, { recursive: true });
git(APPS, ["init", "-q", "-b", "main"]);
writeFileSync(join(APPS, "marketplace.json"), "{}\n");
git(APPS, ["add", "-A"]);
git(APPS, ["commit", "-q", "-m", "init"]);

function scope(branch, s) {
  const dir = join(env.dataDir, "system");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "system-scopes.tmp"), ""); // keep the dir non-empty for clones
  writeFileSync(join(dir, "branch-scopes.json"), JSON.stringify({ [branch]: s }, null, 2));
}

const { coupledReposFor, mountCoupled } = await import("../../tools/supervisor/lib/coupled-repos.mjs");
const { initLogStore } = await import("../../tools/supervisor/lib/log.mjs");
initLogStore(env.dataDir);

test("a coupled branch is cut from the repo's REAL default, not a hardcoded master", async () => {
  // Detach user-apps' HEAD so the `busy` fallback is what decides the base —
  // the same state the plumbing-merge path in promoteCoupled runs under.
  git(APPS, ["checkout", "-q", "--detach", "HEAD"]);
  try {
    const branch = "bos/testfixture-detached-apps";
    const dst = join(env.clones, "detached-apps", "user-apps");
    await mountCoupled({ id: "user-apps", root: APPS, kind: "user-apps" }, dst, branch);
    assert.ok(existsSync(join(dst, ".git")), "user-apps mounted");
    assert.equal(git(APPS, ["rev-parse", "--abbrev-ref", `${branch}`]), branch);
  } finally {
    git(APPS, ["checkout", "-q", "main"]);
  }
});

test("the scope is read from CANONICAL data, not the preview's frozen clone", async () => {
  // A data clone that predates the scope — the ordinary result of
  // provisionClone's deliberate one-shot behaviour plus a branch scoped (or
  // re-scoped) afterwards.
  const branch = "bos/testfixture-police-only";
  const clone = join(env.clones, "police-only-data");
  mkdirSync(join(clone, "system"), { recursive: true });
  writeFileSync(join(clone, "system", "branch-scopes.json"), "{}"); // stale: no scope yet

  scope(branch, { kind: "repository", repoId: "police-mcp" }); // recorded in CANONICAL data

  const repos = await coupledReposFor(join(env.worktrees, "police-only"), clone, branch);
  assert.deepEqual(
    repos.map((r) => r.id),
    ["police-mcp"],
    "a stale clone must not silently demote a repository-scoped branch to the unscoped fallback — " +
      "promote would then skip the one repo holding the work",
  );
});

test("promoting a branch clears its scope — a reused name must not inherit the old one", async () => {
  const { clearCoupledBranchScope } = await import("../../tools/supervisor/lib/coupled-repos.mjs");
  const branch = "bos/testfixture-short-lived";
  scope(branch, { kind: "repository", repoId: "police-mcp" });
  await clearCoupledBranchScope(branch);
  const after = JSON.parse(readFileSync(join(env.dataDir, "system", "branch-scopes.json"), "utf8"));
  assert.ok(!(branch in after), "the promoted branch's scope is gone");
});

test.after(() => env.cleanup());
