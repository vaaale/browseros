// Which repositories a feature branch is created in.
//
// THE REPORTED BUG: a change to one marketplace app created
// `bos/agentic-editor-appearance` in FIVE repositories — BOS's source,
// user-apps, user-specs, the read-only bos-system-specs, and a user's entirely
// unrelated `police-mcp`.
//
// `coupledReposFor` returned every spec store, unconditionally. That was correct
// when the only stores were BOS's own two; 050 made an arbitrary registered
// repository into a spec store, and nothing in the Supervisor knew.
//
//   node --test tests/supervisor/branch-scope.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeSupervisorEnv, makeSpecStore, git } from "./_data-helpers.mjs";

const env = makeSupervisorEnv("branch-scope-");
const { coupledReposFor, listSpecStores, mountedSpecStoresIn } = await import("../../tools/supervisor/lib/coupled-repos.mjs");
const { initLogStore } = await import("../../tools/supervisor/lib/log.mjs");
initLogStore(env.dataDir);

const specsRoot = join(env.dataDir, "specs");
mkdirSync(specsRoot, { recursive: true });

/** A store with an explicit manifest — `owner`/`writable` decide branchability. */
function store(id, manifest) {
  const root = makeSpecStore(specsRoot, id);
  writeFileSync(join(root, "spec-store.json"), JSON.stringify({ id, ...manifest }, null, 2));
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "manifest"]);
  return root;
}

function scopes(map) {
  const dir = join(env.dataDir, "system");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "branch-scopes.json"), JSON.stringify(map, null, 2));
}

// The real shape: BOS's two stores plus a user's registered project.
store("bos-system-specs", { owner: "system", writable: false });
store("user-specs", { owner: "user", writable: true });
store("police-mcp", { owner: "user", writable: true });

const ids = (repos) => repos.map((r) => r.id).sort();

test("the read-only system store is NEVER branched, under any scope", async () => {
  // bos-system-specs is documented read-only and was getting bos/* branches
  // created in it regardless — wrong on its face, and invisible until someone
  // looked at a branch list.
  const all = await listSpecStores();
  assert.equal(all.find((s) => s.id === "bos-system-specs").writable, false);

  scopes({ "bos/testfixture-x": { kind: "bos-core" } });
  for (const scope of [{ kind: "bos-core" }, { kind: "marketplace-item", itemId: "i" }]) {
    scopes({ "bos/testfixture-x": scope });
    const repos = await coupledReposFor(join(env.dataDir, "wt"), env.dataDir, "bos/testfixture-x");
    assert.ok(!ids(repos).includes("bos-system-specs"), `${scope.kind} must not branch the system store`);
  }
});

test("a MARKETPLACE change branches user-apps, and nothing of the user's", async () => {
  scopes({ "bos/testfixture-app": { kind: "marketplace-item", itemId: "agentic-text-editor" } });
  const repos = await coupledReposFor(join(env.dataDir, "wt"), env.dataDir, "bos/testfixture-app");
  assert.deepEqual(ids(repos), ["user-apps"]);
});

test("a BOS CORE change branches user-specs, and nothing of the user's", async () => {
  scopes({ "bos/testfixture-core": { kind: "bos-core" } });
  const repos = await coupledReposFor(join(env.dataDir, "wt"), env.dataDir, "bos/testfixture-core");
  assert.deepEqual(ids(repos), ["user-specs"]);
});

test("work in ONE registered repository branches that repository only", async () => {
  // The headline case: police-mcp is a different project and must not be dragged
  // into a BOS feature, nor should a police-mcp feature touch BOS's stores.
  scopes({ "bos/testfixture-police": { kind: "repository", repoId: "police-mcp" } });
  const repos = await coupledReposFor(join(env.dataDir, "wt"), env.dataDir, "bos/testfixture-police");
  assert.deepEqual(ids(repos), ["police-mcp"]);
});

test("an UNSCOPED branch gets BOS's own repos — never a registered repository", async () => {
  // A branch created before scoping existed keeps working, and the reported
  // damage is still fixed for it: the damage was never in the BOS-owned repos.
  scopes({});
  const repos = await coupledReposFor(join(env.dataDir, "wt"), env.dataDir, "bos/testfixture-legacy");
  assert.deepEqual(ids(repos), ["user-apps", "user-specs"]);
  assert.ok(!ids(repos).includes("police-mcp"));
  assert.ok(!ids(repos).includes("bos-system-specs"));
});

test("the reported bug, end to end: a marketplace change no longer touches five repos", async () => {
  scopes({ "bos/testfixture-agentic-editor-appearance": { kind: "marketplace-item", itemId: "agentic-text-editor" } });
  const repos = await coupledReposFor(join(env.dataDir, "wt"), env.dataDir, "bos/testfixture-agentic-editor-appearance");
  assert.deepEqual(ids(repos), ["user-apps"], "one repo, not five");
});

// ── What the tests above could not catch ───────────────────────────────────
//
// Every test in this file passed while the bug was still live, because they all
// exercise `coupledReposFor` — the function that was already fixed. The branch
// kept appearing in every repository because `beginPreview` mounted from
// `specStoreReposFor`, an UNSCOPED twin returning every store with a mount
// destination attached. Scoping one of two ways to get the same list fixes
// nothing; the second way has to stop existing.

test("there is exactly ONE way to get a mountable repo list", async () => {
  // `mountCoupled`'s `git worktree add -b` is what CREATES a bos/* branch, so a
  // second `*ReposFor` helper returning `dst`-bearing repos is a second, unscoped
  // route to creating branches — which is precisely how this bug survived its
  // own fix. If a new one is genuinely needed, this assertion is the place to
  // argue for it.
  const dir = new URL("../../tools/supervisor/lib/", import.meta.url);
  const offenders = [];
  for (const f of (await readdir(dir)).filter((n) => n.endsWith(".mjs"))) {
    const src = await readFile(new URL(f, dir), "utf8");
    for (const m of src.matchAll(/export async function (\w*ReposFor)\b/g)) {
      if (m[1] !== "coupledReposFor") offenders.push(`${f}: ${m[1]}`);
    }
  }
  assert.deepEqual(offenders, [], "only coupledReposFor may return repos with a mount destination");
});

test("teardown reads the mounts on DISK, not the branch's scope", async () => {
  // The cleanup path safety-commits nested spec-store worktrees before deleting
  // them. It must protect what is really mounted — a mount made under an older
  // scope still holds uncommitted work, and a scoped list would walk past it and
  // then `fs.rm` it.
  const wt = join(env.dataDir, "teardown-wt");
  mkdirSync(join(wt, "specs", "not-a-mount"), { recursive: true });
  const mounted = makeSpecStore(join(wt, "specs"), "left-over-from-an-older-scope");
  assert.ok(mounted, "fixture store created");

  const found = await mountedSpecStoresIn(wt);
  assert.deepEqual(
    found.map((r) => r.id),
    ["left-over-from-an-older-scope"],
    "a real git mount is found even though no scope couples it; a plain directory is not",
  );
  assert.equal(found[0].dst, join(wt, "specs", "left-over-from-an-older-scope"));
});

test("a worktree with no specs/ is not an error", async () => {
  assert.deepEqual(await mountedSpecStoresIn(join(env.dataDir, "never-had-specs")), []);
});
