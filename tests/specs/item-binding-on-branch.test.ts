// REPRODUCTION: creating an app under BMAD *on a feature branch* throws, and
// leaves the app created but unbound.
//
// The live failure, from the deployed box's own self-heal case 0023:
//
//   app_spec_create: unhandled_exception — Unknown spec store
//   "item-follow-the-money". Prefix paths with a store id …
//
// with the item on disk holding exactly one file, `spec/product-brief.md` —
// BMAD's leaf marker. So the workflow WAS passed and WAS resolved (the artifact
// is named by it); what failed is the very next step, recording the binding.
//
// `setItemWorkflow` merges rather than reconstructs, so it READS the manifest
// before writing it — and it read WITHOUT the branch while writing WITH it.
// Under the Supervisor a brand-new item exists only in the branch's data clone,
// so the unbranched read cannot even find the store, throws something that is
// not ENOENT, and the merge's "no manifest yet" path never runs. The read has to
// come from the same place the write goes; anything else is a different file.
//
//   npm run test:unit -- tests/specs/item-binding-on-branch.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { execFileSync } from "child_process";
import { useTestDataDir } from "../services/_test-env";
import { registerMethod, __resetMethodsForTest } from "../../src/lib/specs/method/registry";
import { loadBuiltinDescriptor } from "../../src/lib/specs/method/builtin-pack";
import { METHOD_SCHEMA_VERSION, type MethodDescriptor } from "../../src/lib/specs/method/types";
import { setBranchScope } from "../../src/lib/specs/branch-scope";
import { createItemSpec } from "../../src/lib/specs/create";
import { specTree } from "../../src/lib/specs/pipeline";
import { STORE_MANIFEST } from "../../src/lib/specs/stores";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
}

/** A method whose leaf marker is NOT spec.md — bmad's is `product-brief.md`,
 *  and that difference is what makes an unrecorded binding visible on disk. */
const BMAD: MethodDescriptor = {
  schemaVersion: METHOD_SCHEMA_VERSION,
  id: "bmad",
  label: "BMAD",
  version: "1.0.0",
  sections: [{ rel: "", kind: "active", leafMarker: "product-brief.md", numbering: "nnn-slug" }],
  constitution: "c.md",
  constitutionRoot: "system",
  discrepancies: { rel: "d.md", roots: ["own"] },
  artifacts: [],
  artifactOrder: [],
  phases: [{ id: "p", label: "P", requires: [], rules: [], else: "pending" }],
  stateLabels: { done: "Done", pending: "Pending", blocked: "Blocked", na: "N/A" },
  templates: "templates",
  storeRoot: "specs",
  agents: [],
  roles: {},
};

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

/** The Supervisor client, answering with this branch's worktree + data clone —
 *  the topology that makes base and branch DIFFERENT places. Without it the
 *  item lands in the base checkout and the bug cannot happen at all. */
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

const BRANCH = "bos/testfixture-follow-the-money";

async function withBranchClone(fn: (dirs: { dataDir: string; clone: string }) => Promise<void>): Promise<void> {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- a test fixture, not a hook
  const { dir: dataDir, cleanup } = useTestDataDir("item-binding-on-branch");
  __resetMethodsForTest();
  registerMethod(loadBuiltinDescriptor()); // spec-kit, the global default
  registerMethod(BMAD);
  initUserApps(dataDir); // base: no such item, and never will have until promote
  const worktree = join(dataDir, "preview-worktree");
  mkdirSync(join(worktree, "specs"), { recursive: true });
  const clone = join(dataDir, "preview-data");
  initUserApps(clone, BRANCH);
  await setBranchScope(BRANCH, { kind: "marketplace-item", itemId: "follow-the-money" });
  const restore = stubSupervisor(worktree, clone);
  try {
    await fn({ dataDir, clone });
  } finally {
    restore();
    cleanup();
  }
}

test("creating an item under a method ON A BRANCH binds it, and does not throw", async () => {
  await withBranchClone(async ({ dataDir, clone }) => {
    const { id } = await createItemSpec({
      name: "Follow the Money",
      specBody: "# Follow the Money\n",
      workflow: "bmad",
      branch: BRANCH,
    });
    expect(id).toBe("follow-the-money");

    const itemDir = join(clone, "user-apps", "items", id, "spec");
    // The artifact proves the workflow reached creation…
    expect(existsSync(join(itemDir, "product-brief.md")), "named by BMAD's leaf marker").toBe(true);
    // …and the manifest, next to it, is the half that was lost.
    const manifestPath = join(itemDir, STORE_MANIFEST);
    expect(existsSync(manifestPath), `the binding must be recorded at ${manifestPath}`).toBe(true);
    expect(String((JSON.parse(readFileSync(manifestPath, "utf8")) as { workflow?: string }).workflow)).toContain("bmad");

    // On the branch, and ONLY there — base has no such item to bind.
    expect(existsSync(join(dataDir, "user-apps", "items", id)), "nothing leaked into base").toBe(false);
  });
});

test("and the tree reads that binding back on the branch", async () => {
  await withBranchClone(async () => {
    await createItemSpec({
      name: "Follow the Money",
      specBody: "# Follow the Money\n",
      workflow: "bmad",
      branch: BRANCH,
    });
    const group = (await specTree(BRANCH)).find((g) => g.path === "item-follow-the-money");
    expect(group?.method, "the dropdown's value").toBe("bmad");
    expect(group?.methodBound, "chosen, not inherited").toBe(true);
  });
});

test("an item created with NO method is left unbound, not half-written", async () => {
  await withBranchClone(async ({ clone }) => {
    const { id } = await createItemSpec({ name: "Plain App", specBody: "# Plain\n", branch: BRANCH });
    const itemDir = join(clone, "user-apps", "items", id, "spec");
    expect(existsSync(join(itemDir, "spec.md")), "the default method's leaf marker").toBe(true);
    expect(existsSync(join(itemDir, STORE_MANIFEST)), "no binding claimed").toBe(false);
  });
});
