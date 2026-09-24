// Unit tests for item-owned spec stores: an installed item's own `spec/`
// facet, discovered as its own spec store (src/lib/specs/item-stores.ts)
// rather than requiring "Adopt" to fork it into user-specs/. Covers
// discovery (owner/writable/originLabel), pipeline single-implicit-feature
// handling, and the git-safety fix (commitScoped) — a write inside one
// item's spec/ must never sweep in or commit an unrelated item's dirty,
// uncommitted files elsewhere in the same shared user-apps repo, and must
// never `git init` a stray nested repo inside the spec/ subfolder.
//   npm run test:unit -- tests/specs/item-stores.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync, symlinkSync, appendFileSync } from "fs";
import { execFileSync } from "child_process";
import { useTestDataDir } from "../services/_test-env";
import { listCatalog } from "../../src/lib/marketplace/client";
import { listStores } from "../../src/lib/specs/stores";
import { specTree, listSpecifications, getSpecification, nextFeatureId } from "../../src/lib/specs/pipeline";
import * as specfs from "../../src/lib/dev/spec-fs";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Lays out a local item (under user-apps/items/<id>) with a spec/ facet,
 *  and — via the dataDir()/system/<id> symlink — installs it (035). */
function layOutLocalItemWithSpec(dataDir: string, id: string, specBody: string): string {
  const itemPath = join(dataDir, "user-apps", "items", id);
  mkdirSync(join(itemPath, "spec"), { recursive: true });
  writeFileSync(join(itemPath, "spec", "spec.md"), specBody);
  mkdirSync(join(dataDir, "system"), { recursive: true });
  symlinkSync(itemPath, join(dataDir, "system", id));
  return itemPath;
}

function layOutLocalItemWithApp(dataDir: string, id: string): string {
  const itemPath = join(dataDir, "user-apps", "items", id);
  mkdirSync(join(itemPath, "app"), { recursive: true });
  writeFileSync(join(itemPath, "app", "index.html"), "<!doctype html><title>test app</title>");
  mkdirSync(join(dataDir, "system"), { recursive: true });
  symlinkSync(itemPath, join(dataDir, "system", id));
  return itemPath;
}

function layOutMarketplaceItemWithSpec(dataDir: string, marketplaceId: string, id: string, specBody: string): string {
  const itemPath = join(dataDir, "marketplace", marketplaceId, "items", id);
  mkdirSync(join(itemPath, "spec"), { recursive: true });
  writeFileSync(join(itemPath, "spec", "spec.md"), specBody);
  mkdirSync(join(dataDir, "system"), { recursive: true });
  symlinkSync(itemPath, join(dataDir, "system", id));
  return itemPath;
}

test("discovers an installed local item's spec/ facet as its own writable store", async () => {
  const { dir, cleanup } = useTestDataDir("item-store-local");
  try {
    layOutLocalItemWithSpec(dir, "widget", "# Widget Spec\n\nDocuments the widget item.\n");
    layOutLocalItemWithApp(dir, "other");
    // Discovering the local marketplace also ensureRepo()s user-apps/ — the
    // repo boundary git's own `add -A` walk must stop at, both here and in
    // the write-isolation test below.
    await listCatalog();

    const stores = await listStores();
    const widget = stores.find((s) => s.id === "item-widget");
    expect(widget).toBeTruthy();
    expect(widget?.owner).toBe("item");
    expect(widget?.writable).toBe(true);
    expect(widget?.originLabel).toBe("local");
    // "other" has an app/ facet but no spec/ yet — it still gets a store, so
    // an app installed outside Build Studio's spec-kit flow is discoverable
    // (and can have a spec/ written for it) rather than silently invisible.
    const other = stores.find((s) => s.id === "item-other");
    expect(other).toBeTruthy();
    expect(other?.owner).toBe("item");
    expect(other?.writable).toBe(true);
  } finally {
    cleanup();
  }
});

test("a local item is discoverable as a store even when never installed — editing a spec must not require the data/system symlink", async () => {
  const { dir, cleanup } = useTestDataDir("item-store-uninstalled");
  try {
    // No dataDir()/system/<id> symlink here — just the item sitting in the
    // user's own user-apps/items/, e.g. from cloning a marketplace repo
    // straight into user-apps outside BOS's install flow.
    const itemPath = join(dir, "user-apps", "items", "widget");
    mkdirSync(join(itemPath, "spec"), { recursive: true });
    writeFileSync(join(itemPath, "spec", "spec.md"), "# Widget Spec\n\nDocuments the widget item.\n");
    await listCatalog();

    const stores = await listStores();
    const widget = stores.find((s) => s.id === "item-widget");
    expect(widget).toBeTruthy();
    expect(widget?.owner).toBe("item");
    expect(widget?.writable).toBe(true);
    expect(widget?.originLabel).toBe("local");
  } finally {
    cleanup();
  }
});

test("an item with neither an app/ nor a spec/ facet yet still gets a store — no facet gate on discovery", async () => {
  const { dir, cleanup } = useTestDataDir("item-store-no-facets");
  try {
    // Just a bare folder — e.g. a freshly cloned marketplace repo whose items
    // haven't been scaffolded with app/ or spec/ yet, or a stray README-only
    // directory. It must still show up so it can be worked on.
    const itemPath = join(dir, "user-apps", "items", "bare");
    mkdirSync(itemPath, { recursive: true });
    writeFileSync(join(itemPath, "README.md"), "not an app or spec facet\n");
    await listCatalog();

    const stores = await listStores();
    const bare = stores.find((s) => s.id === "item-bare");
    expect(bare).toBeTruthy();
    expect(bare?.owner).toBe("item");
    expect(bare?.writable).toBe(true);
  } finally {
    cleanup();
  }
});

test("marketplace-sourced item is excluded from item stores entirely — User Apps only surfaces items that live in user-apps", async () => {
  const { dir, cleanup } = useTestDataDir("item-store-marketplace");
  try {
    layOutMarketplaceItemWithSpec(dir, "acme", "gadget", "# Gadget Spec\n");
    const stores = await listStores();
    // "User Apps" means "lives in MY user-apps repo" — an item installed from
    // a marketplace clone isn't in user-apps at all (a real report: an item
    // named "terminal" showed up there despite not existing anywhere under
    // user-apps), so it must not get its own store here at all, not merely a
    // read-only one.
    expect(stores.find((s) => s.id === "item-gadget")).toBeUndefined();

    await expect(specfs.writeFile("item-gadget/spec.md", "nope")).rejects.toThrow(/unknown spec store/i);
  } finally {
    cleanup();
  }
});

test("specTree/listSpecifications treat an item store as one implicit feature", async () => {
  const { dir, cleanup } = useTestDataDir("item-store-tree");
  try {
    layOutLocalItemWithSpec(dir, "widget", "# Widget Spec\n\nDocuments the widget item.\n");
    await listCatalog();

    const tree = await specTree();
    const group = tree.find((g) => g.path === "item-widget");
    expect(group).toBeTruthy();
    expect(group?.owner).toBe("item");
    expect(group?.children).toHaveLength(1);
    const feature = group!.children![0];
    expect(feature.type).toBe("feature");
    expect(feature.path).toBe("item-widget");
    expect(feature.children?.map((c) => c.name)).toContain("spec.md");

    const specs = await listSpecifications();
    const spec = specs.find((s) => s.path === "item-widget");
    expect(spec).toBeTruthy();
    expect(spec?.title).toBe("Widget Spec");
    expect(spec?.phases.find((p) => p.id === "specify")?.state).toBe("done");

    // getSpecification() with a bare store id (no "/<featureId>") is the item-store
    // addressing form — GET /api/specs?id=item-widget goes through this directly.
    const direct = await getSpecification("item-widget");
    expect(direct?.title).toBe("Widget Spec");
    expect(direct?.path).toBe("item-widget");
  } finally {
    cleanup();
  }
});

test("an item's spec write requires an active feature branch, like every other writable store", async () => {
  const { dir, cleanup } = useTestDataDir("item-store-requires-branch");
  try {
    layOutLocalItemWithSpec(dir, "widget", "# Widget Spec\n\nv1.\n");
    await listCatalog(); // discovers the item, ensureRepo()s + commits user-apps/

    // The gate is UNCONDITIONAL — it does not depend on a Supervisor being
    // present (there is none in this test). Only branch ROUTING is
    // Supervisor-conditional; without one the content stays in the base
    // checkout, exactly as user-specs already behaves.
    await expect(specfs.writeFile("item-widget/spec.md", "# Widget Spec\n\nv2.\n")).rejects.toThrow(
      /needs an active feature branch/i,
    );
    // The message must name the RECOVERY, not just the condition. A sub-agent
    // that hits this mid-run cannot otherwise guess what to do: the observed
    // production failure was an agent stalling while it searched its tool list
    // for something that would create a branch.
    await expect(specfs.writeFile("item-widget/spec.md", "# Widget Spec\n\nv2.\n")).rejects.toThrow(
      /dev_branch_request/,
    );

    const userAppsRoot = join(dir, "user-apps");
    expect(git(userAppsRoot, ["show", "HEAD:items/widget/spec/spec.md"])).toContain("v1");
  } finally {
    cleanup();
  }
});

test("an item's spec write lands on the shared user-apps repo's checkout once a branch is supplied", async () => {
  const { dir, cleanup } = useTestDataDir("item-store-follows-checkout");
  try {
    layOutLocalItemWithSpec(dir, "widget", "# Widget Spec\n\nv1.\n");
    await listCatalog();

    const userAppsRoot = join(dir, "user-apps");
    // With no Supervisor there is no branch-coupled worktree to route into, so
    // the write lands in the base checkout — whichever branch that is.
    git(userAppsRoot, ["checkout", "-b", "bos/testfixture-some-feature"]);

    await specfs.writeFile("item-widget/spec.md", "# Widget Spec\n\nv2.\n", { branch: "bos/testfixture-some-feature" });
    expect(git(userAppsRoot, ["log", "-1", "--pretty=%s"])).toContain("spec: write spec.md");
    expect(git(userAppsRoot, ["show", "bos/testfixture-some-feature:items/widget/spec/spec.md"])).toContain("v2");

    // The write landed on that branch specifically — master never saw it.
    git(userAppsRoot, ["checkout", "master"]);
    expect(git(userAppsRoot, ["show", "master:items/widget/spec/spec.md"])).toContain("v1");
  } finally {
    cleanup();
  }
});

test("nextFeatureId refuses to target an item-owned store", async () => {
  const { dir, cleanup } = useTestDataDir("item-store-next-feature-id-guard");
  try {
    layOutLocalItemWithSpec(dir, "widget", "# Widget Spec\n");
    await listCatalog();
    await expect(nextFeatureId("Some New Feature", "item-widget")).rejects.toThrow(/item-owned spec store/i);
  } finally {
    cleanup();
  }
});

test("resolveInStore ACCEPTS a feature-branch context for an item-owned store", async () => {
  const { dir, cleanup } = useTestDataDir("item-store-branch-guard");
  try {
    layOutLocalItemWithSpec(dir, "widget", "# Widget Spec\n");
    await listCatalog();
    // user-apps is branch-coupled now, so an item store takes the same branch
    // context every other store does. Without a Supervisor there is no worktree
    // to route into, so this reads the base checkout rather than throwing —
    // it used to be refused outright ("does not support feature-branch context").
    expect(await specfs.readFile("item-widget/spec.md", { branch: "bos/testfixture-some-feature" })).toContain("Widget Spec");
  } finally {
    cleanup();
  }
});

test("writing an item's spec commits only that item — a sibling item's unrelated dirty file is left untouched", async () => {
  const { dir, cleanup } = useTestDataDir("item-store-write-isolation");
  try {
    const widgetPath = layOutLocalItemWithSpec(dir, "widget", "# Widget Spec\n\nv1.\n");
    const otherPath = layOutLocalItemWithApp(dir, "other");
    await listCatalog(); // discovers both items, ensureRepo()s + commits user-apps/

    const userAppsRoot = join(dir, "user-apps");
    // Simulate an unrelated in-progress edit to a different item, left uncommitted.
    appendFileSync(join(otherPath, "app", "index.html"), "<p>wip</p>");
    const dirtyBefore = git(userAppsRoot, ["status", "--porcelain"]);
    expect(dirtyBefore).toContain("items/other/app/index.html");

    await specfs.writeFile("item-widget/spec.md", "# Widget Spec\n\nv2.\n", { branch: "bos/testfixture-some-feature" });

    // The widget's edit landed and was committed...
    const latestLog = git(userAppsRoot, ["log", "-1", "--name-only", "--pretty=%s"]);
    expect(latestLog).toContain("spec: write spec.md");
    expect(latestLog).toContain("items/widget/spec/spec.md");
    // ...but the sibling item's unrelated, still-dirty file was NOT swept into
    // that commit or otherwise touched — this is the exact hazard commitScoped
    // (vs. a bare `git add -A` from a subdirectory) exists to prevent.
    expect(latestLog).not.toContain("items/other/app/index.html");
    const dirtyAfter = git(userAppsRoot, ["status", "--porcelain"]);
    expect(dirtyAfter).toContain("items/other/app/index.html");

    // And no stray nested repo was created inside the item's spec/ folder.
    const insideSpec = git(join(widgetPath, "spec"), ["rev-parse", "--show-toplevel"]);
    expect(insideSpec).toBe(userAppsRoot);
  } finally {
    cleanup();
  }
});

test("an installed app with no spec/ yet lands in the User Apps group, never conflated with an unrelated user-specs customization of a similar name", async () => {
  const { dir, cleanup } = useTestDataDir("item-store-vs-user-customization");
  try {
    // The real-world regression this guards: an installed item named
    // "workflows" (app/ facet only, no spec/) coexisting with a pre-existing,
    // unrelated user-specs Project literally named "workflow-manager" (a real
    // customization proposal for the built-in Workflow Manager app, authored
    // via Build Studio well before the item ever got its own store). The two
    // must never merge into one group — Build Studio buckets purely on
    // `owner`: "item" renders under "User Apps", anything else (including
    // "user") renders under its own heading (e.g. "My Customizations") —
    // src/apps/build-studio/index.tsx's `tree.filter(g => g.owner === "item")`
    // vs `tree.filter(g => g.owner !== "item")`.
    layOutLocalItemWithApp(dir, "workflows");

    const userSpecsDir = join(dir, "specs", "user-specs");
    mkdirSync(join(userSpecsDir, ".git"), { recursive: true });
    writeFileSync(
      join(userSpecsDir, "spec-store.json"),
      JSON.stringify({ label: "My Customizations", owner: "user", writable: true, requiresPromote: false }, null, 2),
    );
    mkdirSync(join(userSpecsDir, "workflow-manager"), { recursive: true });
    writeFileSync(join(userSpecsDir, "workflow-manager", "project.json"), JSON.stringify({ label: "Workflow Manager" }, null, 2));

    await listCatalog();
    const stores = await listStores();

    const itemStore = stores.find((s) => s.id === "item-workflows");
    expect(itemStore).toBeTruthy();
    expect(itemStore?.owner).toBe("item");

    const userStore = stores.find((s) => s.id === "user-specs");
    expect(userStore).toBeTruthy();
    expect(userStore?.owner).toBe("user");
    expect(userStore?.label).toBe("My Customizations");

    // Exactly the split Build Studio's sidebar renders on.
    const userAppsGroup = stores.filter((s) => s.owner === "item");
    const customizationsGroup = stores.filter((s) => s.owner !== "item");
    expect(userAppsGroup.map((s) => s.id)).toContain("item-workflows");
    expect(customizationsGroup.map((s) => s.id)).not.toContain("item-workflows");
    expect(customizationsGroup.map((s) => s.id)).toContain("user-specs");
  } finally {
    cleanup();
  }
});

test("an item store's READS use the same branch as its writes — no read/write desync", async () => {
  const { dir, cleanup } = useTestDataDir("item-store-read-write-parity");
  try {
    layOutLocalItemWithSpec(dir, "widget", "# Widget Spec\n\nv1.\n");
    await listCatalog();

    const userAppsRoot = join(dir, "user-apps");
    git(userAppsRoot, ["checkout", "-b", "bos/testfixture-some-feature"]);
    const ctx = { branch: "bos/testfixture-some-feature" };

    await specfs.writeFile("item-widget/spec.md", "# Widget Spec\n\nv2.\n", ctx);

    // The exact production failure: a write reported success while the read
    // path kept returning the pre-write content, so the agent could not see its
    // own write, concluded it had failed, and looped re-issuing it. readFile
    // and listDir must resolve through the SAME root writeFile used.
    expect(await specfs.readFile("item-widget/spec.md", ctx)).toContain("v2.");
    const listed = await specfs.listDir("item-widget", ctx);
    const spec = listed.find((e) => e.name === "spec.md");
    expect(spec?.size).toBe((await specfs.readFile("item-widget/spec.md", ctx)).length);
  } finally {
    cleanup();
  }
});
