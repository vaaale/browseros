// REPRODUCTION: a newly created app is invisible in Build Studio.
//
// Creating a marketplace app writes `items/<id>/spec/` into the user-apps
// checkout COUPLED TO THE FEATURE BRANCH — it has to, because every
// `app_spec_*` write is refused without a branch. Under the Supervisor that
// checkout is a separate clone (`<previewDataDir>/user-apps`), not the live
// `data/user-apps`. Live evidence from the deployed box:
//
//   /data-clones/bos/testfixture-item-follow-money/user-apps/items/follow-the-money/spec/spec.md
//   /app/data/user-apps/items/           -> 11 items, none of them follow-the-money
//   GET /api/specs?branch=bos/testfixture-item-follow-money -> 9 item stores, follow-the-money absent
//
// `specTree(branch)` reads each item's CONTENT through the branch, but the SET
// of items comes from `listItemStores()`, which scans `dataDir()/user-apps/items`
// with no branch parameter at all. So the tree can only ever show items that
// already exist on base — which a brand-new app, by construction, never does.
// The agent reports success, the branch and the files are real, and the app
// cannot be seen or opened.
//
// Nothing errored: discovery simply looked in one place while writes went to
// another. Same shape as the coupled-repos bug — a rule that was right when the
// only items were installed ones, made wrong by items being CREATED on a branch.
//
//   npm run test:unit -- tests/specs/branch-only-item-visible.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync, symlinkSync } from "fs";
import { execFileSync } from "child_process";
import { useTestDataDir } from "../services/_test-env";
import { setBranchScope } from "../../src/lib/specs/branch-scope";
import { specTree, listSpecifications } from "../../src/lib/specs/pipeline";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
}

/** One item in a user-apps checkout: `items/<id>/spec/spec.md`, plus the
 *  marketplace manifest entry that names it. */
function layOutItem(userApps: string, id: string, name: string, title: string): void {
  mkdirSync(join(userApps, "items", id, "spec"), { recursive: true });
  writeFileSync(join(userApps, "items", id, "spec", "spec.md"), `# ${title}\n`);
  const manifestPath = join(userApps, "marketplace.json");
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        id: "user-apps",
        name: "My Apps",
        version: "1.0.0",
        items: [{ id, name, app: { entrypoint: "app/index.html", runtime: "iframe" } }],
      },
      null,
      2,
    ),
  );
}

/** The live data dir: user-apps with the one item that is actually installed. */
function layOutBase(dataDir: string): string {
  const userApps = join(dataDir, "user-apps");
  mkdirSync(userApps, { recursive: true });
  git(userApps, ["init", "-q", "-b", "main"]);
  layOutItem(userApps, "agentic-text-editor", "Agentic Text Editor", "Agentic Text Editor");
  mkdirSync(join(dataDir, "system"), { recursive: true });
  symlinkSync(join(userApps, "items", "agentic-text-editor"), join(dataDir, "system", "agentic-text-editor"));
  git(userApps, ["add", "-A"]);
  git(userApps, ["commit", "-q", "-m", "items"]);
  return userApps;
}

/** The Supervisor's preview clone for the branch: the SAME user-apps repo,
 *  checked out on the feature branch, where the new app was written. */
function layOutBranchClone(root: string, baseUserApps: string, branch: string): string {
  mkdirSync(root, { recursive: true });
  const clone = join(root, "user-apps");
  execFileSync("git", ["clone", "-q", baseUserApps, clone]);
  git(clone, ["checkout", "-q", "-b", branch]);
  layOutItem(clone, "follow-the-money", "Follow the Money", "Follow the Money");
  git(clone, ["add", "-A"]);
  git(clone, ["commit", "-q", "-m", "spec: new app"]);
  return clone;
}

/** Make the real Supervisor client believe a Supervisor is up and hand back
 *  this branch's worktree + data clone. Mirrors branch-mount-split-brain.ts's
 *  stub; this one must also answer `dataDir`, since that is where item stores
 *  live (branchItemStoreRoot). */
function stubSupervisor(worktree: string, dataDir: string): () => void {
  const prevUrl = process.env.BOS_SUPERVISOR_URL;
  process.env.BOS_SUPERVISOR_URL = "http://fake-supervisor.invalid";
  const realFetch = global.fetch;
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/__supervisor/begin")) {
      return new Response(JSON.stringify({ ok: true, branch: "x", worktree, dataDir }), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
  return () => {
    if (prevUrl === undefined) delete process.env.BOS_SUPERVISOR_URL;
    else process.env.BOS_SUPERVISOR_URL = prevUrl;
    global.fetch = realFetch;
  };
}

const BRANCH = "bos/testfixture-item-follow-money";

/** The whole fixture: base data dir, branch clone, stubbed Supervisor, scope
 *  recorded exactly as the feature-branches route writes it. */
async function withNewAppOnBranch(fn: () => Promise<void>): Promise<void> {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- a test fixture, not a hook
  const { dir: dataDir, cleanup } = useTestDataDir("branch-only-item");
  const baseUserApps = layOutBase(dataDir);
  const worktree = join(dataDir, "preview-worktree");
  mkdirSync(join(worktree, "specs"), { recursive: true });
  const cloneRoot = join(dataDir, "preview-data");
  layOutBranchClone(cloneRoot, baseUserApps, BRANCH);
  await setBranchScope(BRANCH, { kind: "marketplace-item", itemId: "follow-the-money" });
  const restore = stubSupervisor(worktree, cloneRoot);
  try {
    await fn();
  } finally {
    restore();
    cleanup();
  }
}

test("an app created on a feature branch appears in the tree on that branch", async () => {
  await withNewAppOnBranch(async () => {
    const tree = await specTree(BRANCH);
    const items = tree.filter((g) => g.owner === "item").map((g) => g.path);
    expect(items, "the app that was just created must be in the tree").toContain("item-follow-the-money");
    // And the item that was there all along is still there — discovery is a
    // union, not a swap.
    expect(items).toContain("item-agentic-text-editor");
  });
});

test("the new app is labelled and badged as the branch's own work", async () => {
  await withNewAppOnBranch(async () => {
    const group = (await specTree(BRANCH)).find((g) => g.path === "item-follow-the-money");
    expect(group?.label, "named from the marketplace manifest on the branch").toBe("Follow the Money");
    expect(group?.liveBranch, "the branch the scope says this item belongs to").toBe(BRANCH);
    expect(group?.offBranch, "user-apps IS coupled here, so nothing is off-branch").toBeUndefined();
  });
});

test("its spec is readable — the row is not an empty shell", async () => {
  await withNewAppOnBranch(async () => {
    const spec = (await listSpecifications(BRANCH)).find((s) => s.store === "item-follow-the-money");
    expect(spec, "a spec for the new item").toBeTruthy();
    expect(spec!.title).toBe("Follow the Money");
  });
});

test("off the branch the app does not exist — it has not been promoted", async () => {
  await withNewAppOnBranch(async () => {
    // The counterpart, and the reason this cannot be fixed by scanning both
    // roots unconditionally: base genuinely does not have this app yet. Showing
    // it with no branch active would advertise an app nobody can open.
    const items = (await specTree()).filter((g) => g.owner === "item").map((g) => g.path);
    expect(items).toEqual(["item-agentic-text-editor"]);
  });
});
