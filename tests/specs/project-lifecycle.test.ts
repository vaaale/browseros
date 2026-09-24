// 049 — project lifecycle (FR-006, FR-009, FR-011).
//   npm run test:unit -- tests/specs/project-lifecycle.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { useTestDataDir } from "../services/_test-env";
import { specsRoot } from "../../src/os/specs-dir";
import { ensureStores } from "../../src/lib/specs/seed";
import { listStores } from "../../src/lib/specs/stores";
import { createProject, listProjects, renameProject, deleteProject, projectUnitCount } from "../../src/lib/specs/projects";
import { loadBuiltinDescriptor } from "../../src/lib/specs/method/builtin-pack";
import { bindingScopeOf, kindOf, projectsAre, honoursProjectBinding } from "../../src/lib/specs/store-kind";

const SPEC_KIT = loadBuiltinDescriptor();

/** user-specs is branch-coupled (020) — a write without an active feature
 *  branch is REFUSED, which is FR-013 working. Any non-empty name satisfies the
 *  gate; the worktree cannot materialise under the test data dir, so writes
 *  fall through to the base checkout. */
const BR = { branch: "bos/testfixture-lifecycle-test" };
function write(root: string, rel: string, body: string): void {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
}

test("rename moves the DIRECTORY and the LABEL together", async () => {
  // Two halves of one identity. Moving the directory alone leaves a project
  // displaying its old name; moving the label alone leaves a name nothing
  // resolves to.
  const { cleanup } = useTestDataDir("lifecycle-rename");
  try {
    await ensureStores();
    await createProject("user-specs", "Alpha", undefined, BR);
    write(join(specsRoot(), "user-specs"), "alpha/001-one/spec.md", "# One\n");

    const renamed = await renameProject("user-specs", "alpha", "Document Processing", BR);
    expect(renamed.id).toBe("document-processing");
    expect(renamed.label).toBe("Document Processing");

    const root = join(specsRoot(), "user-specs");
    expect(existsSync(join(root, "document-processing", "001-one", "spec.md")), "content moved with it").toBe(true);
    expect(existsSync(join(root, "alpha")), "and nothing is left behind").toBe(false);
    expect((await listProjects("user-specs")).map((p) => p.id)).toEqual(["document-processing"]);
  } finally {
    cleanup();
  }
});

test("rename PRESERVES manifest keys it does not model", async () => {
  // 045 FR-019: BOS rewrites this file, so a reader that reconstructs from
  // known fields deletes the rest from the user's repo. Four readers in this
  // subsystem did exactly that.
  const { cleanup } = useTestDataDir("lifecycle-rename-preserve");
  try {
    await ensureStores();
    await createProject("user-specs", "Alpha", undefined, BR);
    const root = join(specsRoot(), "user-specs");
    const p = join(root, "alpha", "project.json");
    const before = JSON.parse(readFileSync(p, "utf8"));
    writeFileSync(p, JSON.stringify({ ...before, workflow: "bmad:enterprise", customKey: "keep me" }, null, 2));

    await renameProject("user-specs", "alpha", "Beta", BR);
    const after = JSON.parse(readFileSync(join(root, "beta", "project.json"), "utf8"));
    expect(after.workflow, "the binding survives a rename").toBe("bmad:enterprise");
    expect(after.customKey, "and so does a key this module never heard of").toBe("keep me");
    expect(after.label).toBe("Beta");
  } finally {
    cleanup();
  }
});

test("FR-006 — the unit count a delete confirmation must quote", async () => {
  // "Delete the empty folder I just made" and "delete 30 specs" are the same
  // click without it.
  const { cleanup } = useTestDataDir("lifecycle-count");
  try {
    await ensureStores();
    await createProject("user-specs", "Alpha", undefined, BR);
    const root = join(specsRoot(), "user-specs");
    expect(await projectUnitCount("user-specs", "alpha", SPEC_KIT), "a fresh project holds nothing").toBe(0);

    write(root, "alpha/001-one/spec.md", "# One\n");
    write(root, "alpha/nested/002-two/spec.md", "# Two\n");
    expect(await projectUnitCount("user-specs", "alpha", SPEC_KIT), "nested units count too").toBe(2);

    await deleteProject("user-specs", "alpha", BR);
    expect(existsSync(join(root, "alpha"))).toBe(false);
    expect(await listProjects("user-specs")).toEqual([]);
  } finally {
    cleanup();
  }
});

test("FR-011 — binding scope comes from the store KIND", async () => {
  // One rule cannot be right for all of them: a marketplace repo holds many
  // independent products; user-specs holds refinements to ONE product.
  const { dir, cleanup } = useTestDataDir("lifecycle-kinds");
  try {
    await ensureStores();
    mkdirSync(join(dir, "user-apps", "items", "my-app", "spec"), { recursive: true });
    writeFileSync(join(dir, "user-apps", "items", "my-app", "spec", "spec.md"), "# App\n");

    const stores = await listStores();
    const system = stores.find((s) => s.owner === "system")!;
    const user = stores.find((s) => s.id === "user-specs")!;
    const item = stores.find((s) => s.id === "item-my-app")!;

    expect(kindOf(system)).toBe("system");
    expect(bindingScopeOf(system), "BOS's own specs are read-only").toBe("none");

    expect(bindingScopeOf(user), "BOS is one product — one pipeline for all its specs").toBe("store");
    expect(projectsAre(user), "the 037 folders remain, as organisation and numbering scope").toBe("folders");
    expect(honoursProjectBinding(user), "so a per-project binding here means nothing").toBe(false);

    expect(bindingScopeOf(item), "an item IS a project; its store-level binding is that project's").toBe("store");
    expect(projectsAre(item), "and it contains none").toBe("none");
  } finally {
    cleanup();
  }
});

test("FR-012 — a new item's primary artifact follows the CONFIGURED default", async () => {
  // This is what made Settings -> Build Studio -> Default method inert:
  // primaryArtifactName() passed an EMPTY binding to resolveMethod, so it
  // always fell through to spec-kit and always wrote spec.md. The comment above
  // that function said it existed to prevent exactly this.
  const { cleanup } = useTestDataDir("lifecycle-default-artifact");
  try {
    const { registerMethod, __resetMethodsForTest } = await import("../../src/lib/specs/method/registry");
    const { writeNamespace } = await import("../../src/lib/config/store");
    __resetMethodsForTest();
    registerMethod(SPEC_KIT);
    // A method whose unit is named differently — the case the bug hid.
    registerMethod({
      ...SPEC_KIT, id: "bmad", label: "BMAD",
      sections: [{ rel: "", kind: "active", leafMarker: "product-brief.md", numbering: "nnn-slug" }],
    });
    await writeNamespace("build-studio", { defaultMethod: "bmad" });

    const { createItemSpec } = await import("../../src/lib/specs/create");
    const { id } = await createItemSpec({ name: "Document Processing", specBody: "# Document Processing\n", branch: BR.branch });

    const { listInstalledItems } = await import("../../src/system/items/installed");
    const item = (await listInstalledItems()).find((i) => i.id === id)!;
    expect(existsSync(join(item.itemPath, "spec", "product-brief.md")), "the DEFAULT method's artifact name").toBe(true);
    expect(existsSync(join(item.itemPath, "spec", "spec.md")), "not spec-kit's").toBe(false);
    __resetMethodsForTest();
  } finally {
    cleanup();
  }
});

// The `project.json` exemption from the feature-branch rule is gone. It existed
// so that creating an empty folder did not need a branch — reasonable while
// these stores were all BOS's own, and wrong the moment 050 opened them to the
// user's repositories, where every write is a commit on their branch.
//
// The user-visible shape of that inconsistency: creating a folder in a freshly
// added repository silently succeeded (landing on `main`), and then DELETING it
// was refused for want of a branch. One right-click offered two actions that
// disagreed about whether a branch was required.
test("FR-013 — create and delete agree: BOTH need a feature branch", async () => {
  const { cleanup } = useTestDataDir("lifecycle-branch-parity");
  try {
    await ensureStores();

    // Create is not exempt. It used to be, and that is the whole defect.
    await expect(createProject("user-specs", "Alpha")).rejects.toThrow(/feature branch/i);
    expect((await listProjects("user-specs")).map((p) => p.id), "and nothing was left behind").toEqual([]);

    // With a branch, both halves work — the point is that they AGREE, not that
    // writes got harder.
    await createProject("user-specs", "Alpha", undefined, BR);
    expect((await listProjects("user-specs")).map((p) => p.id)).toEqual(["alpha"]);
    await deleteProject("user-specs", "alpha", BR);
    expect((await listProjects("user-specs")).map((p) => p.id)).toEqual([]);
  } finally {
    cleanup();
  }
});

// The refusal carries a CODE, because its message is written for an agent (it
// names dev_branch_request and the retry) and Build Studio showed that text to a
// person — instructions for a tool they do not have, describing a step the
// branch selector in front of them already performs.
test("the branch refusal is identifiable without parsing its prose", async () => {
  const { cleanup } = useTestDataDir("lifecycle-branch-code");
  try {
    await ensureStores();
    const { BRANCH_REQUIRED } = await import("../../src/lib/specs/error-codes");
    const err = await createProject("user-specs", "Alpha").catch((e) => e as Error & { code?: string });
    expect(err.code).toBe(BRANCH_REQUIRED);
    // The agent-facing recovery is still in the message — both audiences served.
    expect(err.message).toContain("dev_branch_request");
  } finally {
    cleanup();
  }
});
