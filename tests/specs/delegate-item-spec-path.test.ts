// REPRODUCTION: the agent cannot hand the Developer the spec of the app it
// just built.
//
// From the live trajectory ("Money flow investment strategy analysis"), at the
// `implement` step:
//
//   agent_delegate({ specPath: "item-follow-the-money", … })
//   -> Error: agent_delegate: specPath "item-follow-the-money" could not be
//      resolved: Unknown spec store "item-follow-the-money".
//
// and then the cascade that followed, all of it caused by that one error: the
// agent hand-wrote the absolute host path into the task body instead, which
// tripped the contentOnly guard's BOS-source wording check, so it rewrote the
// task again to get past THAT. Three turns of workaround for one lookup.
//
// `delegate-common.ts` resolves `specPath` through `resolveStoreRoot`, which is
// documented as taking no branch on purpose (history browsing wants every
// branch). For DISCOVERY that reasoning does not hold: an app created on a
// feature branch has no base record at all, so "no branch" means "no store".
// This was in the audit list of branch-blind lookups and was left there — the
// one on the delegation path.
//
//   npm run test:unit -- tests/specs/delegate-item-spec-path.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { useTestDataDir } from "../services/_test-env";
import * as specfs from "../../src/lib/dev/spec-fs";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
}

function initUserApps(root: string, branch?: string): string {
  const apps = join(root, "user-apps");
  mkdirSync(apps, { recursive: true });
  git(apps, ["init", "-q", "-b", "main"]);
  writeFileSync(
    join(apps, "marketplace.json"),
    JSON.stringify({ id: "user-apps", name: "My Apps", version: "1.0.0", items: [] }, null, 2),
  );
  git(apps, ["add", "-A"]);
  git(apps, ["commit", "-q", "-m", "init"]);
  if (branch) git(apps, ["checkout", "-q", "-b", branch]);
  return apps;
}

function stubSupervisor(worktree: string, dataDir: string): () => void {
  const prevUrl = process.env.BOS_SUPERVISOR_URL;
  process.env.BOS_SUPERVISOR_URL = "http://fake-supervisor.invalid";
  const realFetch = global.fetch;
  global.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("/__supervisor/begin")) {
      return new Response(JSON.stringify({ ok: true, branch: "x", worktree, dataDir }), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${String(input)}`);
  }) as typeof fetch;
  return () => {
    if (prevUrl === undefined) delete process.env.BOS_SUPERVISOR_URL;
    else process.env.BOS_SUPERVISOR_URL = prevUrl;
    global.fetch = realFetch;
  };
}

const BRANCH = "bos/testfixture-follow-the-money";

/** Base and branch as DIFFERENT checkouts, with the app only on the branch —
 *  the state every newly created app is in until it promotes. */
async function withAppOnBranch(fn: (clone: string) => Promise<void>): Promise<void> {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- a test fixture, not a hook
  const { dir, cleanup } = useTestDataDir("delegate-item-spec-path");
  initUserApps(dir);
  const worktree = join(dir, "preview-worktree");
  mkdirSync(join(worktree, "specs"), { recursive: true });
  const clone = join(dir, "preview-data");
  initUserApps(clone, BRANCH);
  const spec = join(clone, "user-apps", "items", "follow-the-money", "spec");
  mkdirSync(spec, { recursive: true });
  for (const f of ["spec.md", "design.md", "plan.md", "tasks.md", "mockup.html"]) {
    writeFileSync(join(spec, f), `# ${f}\n`);
  }
  const restore = stubSupervisor(worktree, clone);
  try {
    await fn(clone);
  } finally {
    restore();
    cleanup();
  }
}

test("an item that exists only on the branch is resolvable BY the branch", async () => {
  await withAppOnBranch(async () => {
    // What delegate-common does first, and where it failed.
    const { store, rel } = await specfs.resolveStoreRoot("item-follow-the-money", BRANCH);
    expect(store.id).toBe("item-follow-the-money");
    expect(store.owner).toBe("item");
    expect(rel).toBe("");
  });
});

test("and resolves to the spec directory ON that branch, not a base path", async () => {
  await withAppOnBranch(async (clone) => {
    // The absolute path handed to the Developer. It must be the branch's copy —
    // base has no such directory at all, so a base-resolved path would point at
    // nothing and the Developer would report the spec as missing.
    const abs = await specfs.resolveAbsolutePath("item-follow-the-money", { branch: BRANCH });
    expect(abs).toBe(join(clone, "user-apps", "items", "follow-the-money", "spec"));
  });
});

test("without a branch it is still unknown — the error was not wrong, just unanswerable", async () => {
  await withAppOnBranch(async () => {
    // Off the branch this app genuinely does not exist. The fix is to ASK with
    // the branch, not to make the unbranched lookup start inventing stores.
    await expect(specfs.resolveStoreRoot("item-follow-the-money")).rejects.toThrow(/Unknown spec store/);
  });
});

test("delegate-common asks with the branch it already has", async () => {
  // The call site is behind a Claude-CLI spawn, so this pins the two lines
  // rather than the run: the resolution must use `featureBranch`, and the item
  // case must NOT be excluded from branch routing — that exclusion is what
  // pointed the Developer at a base path that does not exist.
  const { readFileSync } = await import("fs");
  const src = readFileSync("src/lib/assistant/tools/server/delegate-common.ts", "utf8");
  expect(src, "the store lookup must carry the branch").toContain("resolveStoreRoot(specPath, featureBranch)");
  expect(src, "and the item store must route through it like every other store").not.toContain(
    'store.owner === "item" ? undefined',
  );
});
