import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { useTestDataDir } from "../services/_test-env";
import { specsRoot } from "../../src/os/specs-dir";
import { ensureStores } from "../../src/lib/specs/seed";
import { createProjectIn, renameProjectIn, deleteProjectIn, describeProjectDeletion } from "../../src/lib/specs/lifecycle";

const BR = { branch: "bos/testfixture-lc-test" };

test("FR-002a — a folder in a user-spec store", async () => {
  const { cleanup } = useTestDataDir("lc-folder");
  try {
    await ensureStores();
    const p = await createProjectIn("user-specs", "Network Filesystem support", BR);
    expect(p.unit).toBe("folder");
    expect(p.id).toBe("network-filesystem-support");
    expect(existsSync(join(specsRoot(), "user-specs", p.id, "project.json"))).toBe(true);

    const renamed = await renameProjectIn("user-specs", p.id, "Network FS", BR);
    expect(renamed.id).toBe("network-fs");

    const d = await describeProjectDeletion("user-specs", "network-fs");
    expect(d.units, "a fresh folder holds nothing").toBe(0);
    await deleteProjectIn("user-specs", "network-fs", BR);
    expect(existsSync(join(specsRoot(), "user-specs", "network-fs"))).toBe(false);
  } finally { cleanup(); }
});

test("FR-002c — a workflow cannot be passed to a store-scoped kind", async () => {
  const { cleanup } = useTestDataDir("lc-workflow-refused");
  try {
    await ensureStores();
    let err: Error | undefined;
    await createProjectIn("user-specs", "X", { ...BR, workflow: "spec-kit" }).catch((e: Error) => { err = e; });
    expect(err, "silently ignoring it would record an intent the product does not honour").toBeDefined();
    expect(err!.message).toMatch(/binds ONE workflow/);
  } finally { cleanup(); }
});

test("the read-only system store is refused, with the reason", async () => {
  const { cleanup } = useTestDataDir("lc-system");
  try {
    await ensureStores();
    let err: Error | undefined;
    await createProjectIn("bos-system-specs", "X", BR).catch((e: Error) => { err = e; });
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/read-only/i);
  } finally { cleanup(); }
});

test("an ITEM store contains no projects", async () => {
  const { dir, cleanup } = useTestDataDir("lc-item");
  try {
    await ensureStores();
    mkdirSync(join(dir, "user-apps", "items", "my-app", "spec"), { recursive: true });
    writeFileSync(join(dir, "user-apps", "items", "my-app", "spec", "spec.md"), "# App\n");
    let err: Error | undefined;
    await createProjectIn("item-my-app", "X", BR).catch((e: Error) => { err = e; });
    expect(err, "an item IS a project; it contains none").toBeDefined();
    expect(err!.message).toMatch(/itself a single project/);
  } finally { cleanup(); }
});

test("the headline case — an app created under a named workflow, in ONE call", async () => {
  // The question 049 exists to answer. It previously took four steps: create
  // (gets spec.md), bind to BMAD, watch the preflight warn that a unit would be
  // hidden, rename the file by hand.
  const { cleanup } = useTestDataDir("lc-headline");
  try {
    await ensureStores();
    const { registerMethod, __resetMethodsForTest } = await import("../../src/lib/specs/method/registry");
    const { loadBuiltinDescriptor } = await import("../../src/lib/specs/method/builtin-pack");
    const SK = loadBuiltinDescriptor();
    __resetMethodsForTest();
    registerMethod(SK);
    registerMethod({
      ...SK, id: "bmad", label: "BMAD",
      sections: [{ rel: "", kind: "active", leafMarker: "product-brief.md", numbering: "nnn-slug" }],
      workflows: [{ id: "enterprise", default: true }, { id: "simple" }],
    });

    const p = await createProjectIn("user-apps", "Document Processing", { ...BR, workflow: "bmad:enterprise" });
    expect(p.unit, "a marketplace store's projects ARE its items").toBe("item");

    const { listInstalledItems } = await import("../../src/system/items/installed");
    const item = (await listInstalledItems()).find((i) => i.id === p.id)!;
    // The ARTIFACT'S NAME is the assertion. "The binding was recorded" was true
    // the whole time the wrong file was being written.
    expect(existsSync(join(item.itemPath, "spec", "product-brief.md")), "BMAD's leaf marker, from birth").toBe(true);
    expect(existsSync(join(item.itemPath, "spec", "spec.md")), "not spec-kit's").toBe(false);

    const manifest = JSON.parse(
      readFileSync(join(item.itemPath, "spec", "spec-store.json"), "utf8"),
    ) as { workflow?: string };
    expect(manifest.workflow, "and the binding travels with the item").toBe("bmad:enterprise");
    __resetMethodsForTest();
  } finally { cleanup(); }
});

test("T014 — the tree tells the client where a binding can take effect", async () => {
  // The per-Project picker rendered in user-specs, where a project-level
  // binding is never honoured — a control advertising a choice the product
  // ignores. The client cannot know that on its own, so the server says it
  // (Principle II: the server decides, the client displays).
  const { dir, cleanup } = useTestDataDir("lc-scope-on-tree");
  try {
    await ensureStores();
    mkdirSync(join(dir, "user-apps", "items", "my-app", "spec"), { recursive: true });
    writeFileSync(join(dir, "user-apps", "items", "my-app", "spec", "spec.md"), "# App\n");

    const { specTree } = await import("../../src/lib/specs/pipeline");
    const tree = await specTree();
    const byName = Object.fromEntries(tree.map((g) => [g.name, g]));

    expect(byName["user-specs"].bindingScope, "BOS is one product — one pipeline").toBe("store");
    expect(byName["user-specs"].projectUnit, "and it still holds folders").toBe("folders");

    expect(byName["bos-system-specs"].bindingScope, "read-only binds nowhere").toBe("none");
    expect(byName["bos-system-specs"].projectUnit).toBe("none");

    expect(byName["item-my-app"].projectUnit, "an item IS a project; it contains none").toBe("none");
  } finally { cleanup(); }
});
