// THE WHOLE FLOW, the way the agent actually performs it: create an app under a
// named method on a feature branch, then keep working on it.
//
// Three fixes in a row each fixed a real break in this flow and then stopped at
// the next lookup that was also branch-blind — item DISCOVERY, then the BINDING
// write, then the binding READ. Each time the piece under test passed while the
// flow still failed one step later. So this test does not test a piece: it walks
// the sequence a real session performs, through the agent's own tools, against
// the topology the Supervisor actually creates (base and branch are DIFFERENT
// checkouts). Anything on that path that cannot see the branch fails here.
//
//   npm run test:unit -- tests/specs/agent-creates-app-on-branch.test.ts
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
import { specTree } from "../../src/lib/specs/pipeline";
import { itemSpecTools } from "../../src/lib/assistant/tools/server/specs";
import { STORE_MANIFEST } from "../../src/lib/specs/stores";
import type { ToolContext } from "../../src/lib/assistant/tools";
import * as conversations from "../../src/lib/agent/conversations-server";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
}

/** BMAD's real shape, for this purpose: a leaf marker that is NOT spec.md, so a
 *  binding that silently reverted to the default is visible on disk. */
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

/** The tools read the active branch off the CONVERSATION. Seeding a real one
 *  would write into /Documents/Chats, which os/vfs.ts routes through the
 *  canonical data root — the leak app-spec-tools.test.ts documents. Replacing
 *  the one accessor keeps that whole mechanism out of this test. */
function stubActiveBranch(branch: string): () => void {
  const mod = conversations as unknown as Record<string, unknown>;
  const real = mod.getConversationActiveFeatureBranch;
  mod.getConversationActiveFeatureBranch = async () => branch;
  return () => {
    mod.getConversationActiveFeatureBranch = real;
  };
}

function ctx(): ToolContext {
  return {
    signal: new AbortController().signal,
    conversationId: "test-conversation",
    agentId: "test-agent",
    onEvent: () => {},
    elicit: async () => "",
    delegationDepth: 0,
    runId: "test-run",
  };
}

const BRANCH = "bos/testfixture-follow-the-money";

test("create an app under BMAD on a branch, then keep working on it", async () => {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- a test fixture, not a hook
  const { dir: dataDir, cleanup } = useTestDataDir("agent-creates-app");
  __resetMethodsForTest();
  registerMethod(loadBuiltinDescriptor()); // spec-kit, the global default
  registerMethod(BMAD);
  initUserApps(dataDir); // base: this app does not exist and will not until promote
  const worktree = join(dataDir, "preview-worktree");
  mkdirSync(join(worktree, "specs"), { recursive: true });
  const clone = join(dataDir, "preview-data");
  initUserApps(clone, BRANCH);
  await setBranchScope(BRANCH, { kind: "marketplace-item", itemId: "follow-the-money" });
  const restoreSupervisor = stubSupervisor(worktree, clone);
  const restoreBranch = stubActiveBranch(BRANCH);

  try {
    const tools = itemSpecTools();
    const c = ctx();

    // 1. "Build an app called Follow the Money using the BMAD method."
    const created = String(await tools.app_spec_create.execute(
      { name: "Follow the Money", specBody: "# Follow the Money\n", workflow: "bmad" },
      c,
    ));
    expect(created, `creation must not error: ${created}`).not.toMatch(/^Error:/);
    expect(created, "and it says which method it bound").toContain("bmad");

    const specDir = join(clone, "user-apps", "items", "follow-the-money", "spec");
    expect(existsSync(join(specDir, "product-brief.md")), "BMAD's leaf marker, not spec.md").toBe(true);
    expect(existsSync(join(specDir, "spec.md")), "the default method's marker must NOT be what was written").toBe(false);
    expect(
      String((JSON.parse(readFileSync(join(specDir, STORE_MANIFEST), "utf8")) as { workflow?: string }).workflow),
      "the binding is recorded next to the artifact",
    ).toContain("bmad");

    // 2. The agent lists what it just made. This is the step that used to fail
    //    with `Unknown spec store "item-follow-the-money"`: the guard on every
    //    app_spec_* tool looked the store up on base only.
    const listed = String(await tools.app_spec_list.execute({ path: "item-follow-the-money" }, c));
    expect(listed, `list must not error: ${listed}`).not.toMatch(/^Error:/);
    expect(listed).toContain("product-brief.md");

    // 3. Reads its own writing back.
    const read = String(await tools.app_spec_read.execute({ path: "item-follow-the-money/product-brief.md" }, c));
    expect(read, `read must not error: ${read}`).not.toMatch(/^Error:/);
    expect(read).toContain("Follow the Money");

    // 4. Writes the next artifact, and edits one — the rest of authoring.
    const wrote = String(await tools.app_spec_write.execute(
      { path: "item-follow-the-money/product-brief.md", content: "# Follow the Money\n\nMoney flows.\n" },
      c,
    ));
    expect(wrote, `write must not error: ${wrote}`).not.toMatch(/^Error:/);
    const edited = String(await tools.app_spec_edit.execute(
      { path: "item-follow-the-money/product-brief.md", find: "Money flows.", replace: "Money moves." },
      c,
    ));
    expect(edited, `edit must not error: ${edited}`).not.toMatch(/^Error:/);
    expect(readFileSync(join(specDir, "product-brief.md"), "utf8")).toContain("Money moves.");

    // 5. What Build Studio then draws: the app is there, on this branch, on BMAD.
    const group = (await specTree(BRANCH)).find((g) => g.path === "item-follow-the-money");
    expect(group, "the app must appear in the tree").toBeTruthy();
    // Title-cased from the ID, not "Follow the Money" from the manifest: an
    // item created on a branch is not added to that clone's marketplace.json
    // (BOS merges that manifest lazily, and on the branch nothing has yet), so
    // the display name falls back to the id. The live box shows the same.
    // Cosmetic — the app is there and openable — but pinned here so it is a
    // known state rather than a surprise.
    expect(group!.label).toBe("Follow The Money");
    expect(group!.method, "the dropdown's value").toBe("bmad");
    expect(group!.methodBound, "chosen, not inherited").toBe(true);
    expect(group!.liveBranch).toBe(BRANCH);

    // 6. And none of it leaked into base, which has not promoted anything.
    expect(existsSync(join(dataDir, "user-apps", "items", "follow-the-money"))).toBe(false);
    expect((await specTree()).some((g) => g.path === "item-follow-the-money")).toBe(false);
  } finally {
    restoreBranch();
    restoreSupervisor();
    cleanup();
  }
});

// REPRODUCTION: the branch badge is gone from the tree.
//
// Live on the box, after everything else started working:
//
//   { "bos/follow-money-marketplace-item": { "kind": "marketplace-item" } }
//
// No `itemId`. The agent called dev_branch_request with scope
// `marketplace-item` and no scopeId — which the route accepts on purpose,
// because the branch has to exist BEFORE the app does, so there is often no id
// to give yet. The cost was pinned in branch-scope-item-id.test.ts as a known
// degraded state: with no itemId, nothing can be attributed, so no row shows
// the branch.
//
// But the id STOPS being unknown the moment the app is created — on that
// branch, with that id, as a fact rather than a guess. Leaving the scope at its
// initial ignorance is what makes the badge permanently absent for exactly the
// flow that cannot supply an id up front.
test("creating the app on an unattributed marketplace branch attributes it", async () => {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- a test fixture, not a hook
  const { dir: dataDir, cleanup } = useTestDataDir("agent-attributes-branch");
  __resetMethodsForTest();
  registerMethod(loadBuiltinDescriptor());
  registerMethod(BMAD);
  initUserApps(dataDir);
  const worktree = join(dataDir, "preview-worktree");
  mkdirSync(join(worktree, "specs"), { recursive: true });
  const clone = join(dataDir, "preview-data");
  initUserApps(clone, BRANCH);
  // EXACTLY what the box holds: the kind, and nothing else.
  await setBranchScope(BRANCH, { kind: "marketplace-item" });
  const restoreSupervisor = stubSupervisor(worktree, clone);
  const restoreBranch = stubActiveBranch(BRANCH);

  try {
    await itemSpecTools().app_spec_create.execute(
      { name: "Follow the Money", specBody: "# Follow the Money\n", workflow: "bmad" },
      ctx(),
    );

    const { getBranchScope } = await import("../../src/lib/specs/branch-scope");
    expect(await getBranchScope(BRANCH), "the branch now knows which item it is for").toEqual({
      kind: "marketplace-item",
      itemId: "follow-the-money",
    });

    const group = (await specTree(BRANCH)).find((g) => g.path === "item-follow-the-money");
    expect(group?.liveBranch, "so the row can say it is being worked on").toBe(BRANCH);
    // And ONLY that row — the other eleven items share the same user-apps repo
    // and must not all claim the branch.
    expect((await specTree(BRANCH)).filter((g) => g.liveBranch).map((g) => g.path)).toEqual([
      "item-follow-the-money",
    ]);
  } finally {
    restoreBranch();
    restoreSupervisor();
    cleanup();
  }
});
