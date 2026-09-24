// 045 T015/T016/T017/T020 — the binding chain and its persistence (FR-008, US3).
//
// The three bugs this pins are all SILENT: two readers that reconstruct a fixed
// object and drop unknown keys, and a seed that rewrites the manifest on every
// boot. Each would leave the binding apparently set and actually unset.
//   npm run test:unit -- tests/specs/method-binding.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync, readFileSync } from "fs";
import { useTestDataDir } from "../services/_test-env";
import { specsRoot } from "../../src/os/specs-dir";
import { ensureStores } from "../../src/lib/specs/seed";
import { listStores } from "../../src/lib/specs/stores";
import { listProjects } from "../../src/lib/specs/projects";
import { resolveMethod, DEFAULT_METHOD_ID, MethodNotInstalledError } from "../../src/lib/specs/method/resolve";
import { registerMethod, __resetMethodsForTest } from "../../src/lib/specs/method/registry";
// 046 T006: the descriptor is the PACK's method.json now, not a TS module.
import { loadBuiltinDescriptor } from "../../src/lib/specs/method/builtin-pack";
const SPEC_KIT = loadBuiltinDescriptor();
import type { MethodDescriptor } from "../../src/lib/specs/method/types";

const OTHER: MethodDescriptor = { ...SPEC_KIT, id: "other", label: "Other" };

function write(root: string, rel: string, body: string): void {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
}

test("a method set on spec-store.json is READ back (not dropped by readManifest)", async () => {
  const { cleanup } = useTestDataDir("binding-store");
  try {
    await ensureStores();
    const dir = join(specsRoot(), "user-specs");
    const manifest = JSON.parse(readFileSync(join(dir, "spec-store.json"), "utf8"));
    writeFileSync(join(dir, "spec-store.json"), JSON.stringify({ ...manifest, method: "other" }, null, 2));

    const store = (await listStores()).find((s) => s.id === "user-specs");
    // readManifest RECONSTRUCTS a fixed object; a field it does not name is
    // silently dropped, so the binding would read as unset with no error.
    expect(store?.method).toBe("other");
  } finally {
    cleanup();
  }
});

test("US3 scenario 3 — a method survives a server restart", async () => {
  // seed.ts preserved only `label` and rewrote the rest from USER_MANIFEST on
  // EVERY boot, so a method assigned through the picker survived exactly until
  // the next restart and then silently reverted to spec-kit.
  const { cleanup } = useTestDataDir("binding-restart");
  try {
    await ensureStores();
    const dir = join(specsRoot(), "user-specs");
    const manifest = JSON.parse(readFileSync(join(dir, "spec-store.json"), "utf8"));
    writeFileSync(join(dir, "spec-store.json"), JSON.stringify({ ...manifest, method: "other" }, null, 2));

    await ensureStores(); // the restart

    expect(JSON.parse(readFileSync(join(dir, "spec-store.json"), "utf8")).method).toBe("other");
    expect((await listStores()).find((s) => s.id === "user-specs")?.method).toBe("other");
  } finally {
    cleanup();
  }
});

test("a per-Project override is read back (not dropped by readProjectManifest)", async () => {
  const { cleanup } = useTestDataDir("binding-project");
  try {
    await ensureStores();
    const dir = join(specsRoot(), "user-specs");
    write(dir, "alpha/project.json", JSON.stringify({ label: "Alpha", method: "other" }));
    write(dir, "alpha/001-x/spec.md", "# X\n");

    const project = (await listProjects("user-specs")).find((p) => p.id === "alpha");
    expect(project?.method).toBe("other");
  } finally {
    cleanup();
  }
});

test("precedence: project > store > global default > spec-kit", () => {
  __resetMethodsForTest();
  registerMethod(SPEC_KIT);
  registerMethod(OTHER);
  registerMethod({ ...SPEC_KIT, id: "third", label: "Third" });

  expect(resolveMethod({}, "s").id, "absent everywhere ⇒ spec-kit, so nothing changes for existing stores").toBe(DEFAULT_METHOD_ID);
  expect(resolveMethod({ globalDefault: "other" }, "s").id).toBe("other");
  expect(resolveMethod({ globalDefault: "other", store: "third" }, "s").id, "store beats the global default").toBe("third");
  expect(resolveMethod({ globalDefault: "other", store: "third", project: "spec-kit" }, "s").id, "project is most specific").toBe("spec-kit");
});

test("FR-016 — a store bound to an uninstalled method THROWS rather than falling back", () => {
  // Never silently resolve to spec-kit here. A store authored under another
  // framework, reinterpreted through spec-kit's rules, renders confident and
  // wrong — which is worse than rendering an error.
  __resetMethodsForTest();
  registerMethod(SPEC_KIT);
  let err: Error | undefined;
  try {
    resolveMethod({ store: "openspec" }, "user-specs");
  } catch (e) {
    err = e as Error;
  }
  expect(err).toBeInstanceOf(MethodNotInstalledError);
  expect(err!.message, "names the store AND the missing method").toMatch(/user-specs.*openspec|openspec.*user-specs/);
});

// ---------------------------------------------------------------------------
// The binding chain had three levels and only ONE was reachable. These pin the
// other two, plus the read the UI actually performs.
//
// The gap was not in the resolver — `resolveMethod` honoured project > store >
// global from the start, and the test above proves it. It was that nothing
// could SET or DISPLAY the finer levels, so the passing test described a
// capability the product did not expose. A resolver test cannot notice that.
// ---------------------------------------------------------------------------

test("an item store's method is read from its own spec/spec-store.json", async () => {
  // Item stores are SYNTHESISED — no manifest of their own — so `store.method`
  // was permanently undefined for every item and the chain could only ever
  // reach the global default. The picker then showed a value it had not read.
  const { dir, cleanup } = useTestDataDir("binding-item-store");
  try {
    const itemPath = join(dir, "user-apps", "items", "my-app");
    mkdirSync(join(itemPath, "spec"), { recursive: true });
    writeFileSync(join(itemPath, "spec", "spec.md"), "# My App\n");
    writeFileSync(join(itemPath, "spec", "spec-store.json"), JSON.stringify({ method: "other" }));

    const store = (await listStores()).find((s) => s.id === "item-my-app");
    expect(store?.method, "the binding travels WITH the item's specs").toBe("other");
  } finally {
    cleanup();
  }
});

test("an item store's manifest cannot override its identity — only `method` is taken", async () => {
  // The file sits inside user-apps, which any item can write to. Honouring
  // `label`/`owner` from it would let one item present itself as another, or
  // as a system store, in the sidebar.
  const { dir, cleanup } = useTestDataDir("binding-item-spoof");
  try {
    const itemPath = join(dir, "user-apps", "items", "plain-app");
    mkdirSync(join(itemPath, "spec"), { recursive: true });
    writeFileSync(
      join(itemPath, "spec", "spec-store.json"),
      JSON.stringify({ method: "other", label: "bos-system-specs", owner: "system", writable: false }),
    );

    const store = (await listStores()).find((s) => s.id === "item-plain-app");
    expect(store?.method).toBe("other");
    expect(store?.owner, "owner comes from being an item, never from the file").toBe("item");
    expect(store?.label, "label comes from the item's own manifest").not.toBe("bos-system-specs");
  } finally {
    cleanup();
  }
});

test("a malformed item manifest leaves the item usable", async () => {
  // An unparseable file must not remove the item from the sidebar — that reads
  // as the item being deleted.
  const { dir, cleanup } = useTestDataDir("binding-item-malformed");
  try {
    const itemPath = join(dir, "user-apps", "items", "broken-app");
    mkdirSync(join(itemPath, "spec"), { recursive: true });
    writeFileSync(join(itemPath, "spec", "spec-store.json"), "{ not json");

    const store = (await listStores()).find((s) => s.id === "item-broken-app");
    expect(store, "still discovered").toBeDefined();
    expect(store?.method, "falls back to the chain, not to a crash").toBeUndefined();
  } finally {
    cleanup();
  }
});

test("the TREE carries each node's OWN method — one store's binding is not shown on another", async () => {
  // The UI read `activeMethodSummary()`, which is hardcoded to user-specs, and
  // rendered it as EVERY store's dropdown value. Binding any other store left
  // its picker displaying user-specs' method — the control disagreed with the
  // binding BOS would actually apply. Resolving per node is what makes the
  // displayed value and the applied value the same read.
  const { dir, cleanup } = useTestDataDir("binding-tree-per-node");
  try {
    __resetMethodsForTest();
    registerMethod(SPEC_KIT);
    registerMethod(OTHER);
    await ensureStores();

    const userSpecs = join(specsRoot(), "user-specs");
    const manifest = JSON.parse(readFileSync(join(userSpecs, "spec-store.json"), "utf8"));
    writeFileSync(join(userSpecs, "spec-store.json"), JSON.stringify({ ...manifest, method: "other" }, null, 2));

    // A second store that is NOT bound — it must not inherit user-specs' pick.
    const itemPath = join(dir, "user-apps", "items", "unbound-app");
    mkdirSync(join(itemPath, "spec"), { recursive: true });
    writeFileSync(join(itemPath, "spec", "spec.md"), "# Unbound\n");

    const { specTree } = await import("../../src/lib/specs/pipeline");
    const tree = await specTree();

    const bound = tree.find((g) => g.name === "user-specs");
    expect(bound?.method).toBe("other");
    expect(bound?.methodBound, "declared here, not inherited").toBe(true);

    // The item's row is the synthetic feature node, not the group header — but
    // the GROUP must agree with its own child. Carrying the binding on only the
    // drawn node left every non-UI reader seeing `undefined` for item stores.
    const itemGroup = tree.find((g) => g.name === "item-unbound-app");
    expect(itemGroup?.method, "the group reports its store's binding too").toBe(DEFAULT_METHOD_ID);
    const itemRow = itemGroup?.children?.[0];
    expect(itemRow?.method, "resolves independently of user-specs").toBe(DEFAULT_METHOD_ID);
    expect(itemRow?.methodBound, "inherited — the picker must say so").toBe(false);
  } finally {
    __resetMethodsForTest();
    cleanup();
  }
});

test("a store that binds at STORE level ignores a per-project binding, and reports it", async () => {
  // Binding scope is a property of the repository KIND. `user-specs` holds
  // refinements to ONE product, so one pipeline governs all of it; its folders
  // are organisation and feature-numbering scope, not binding points.
  //
  // A binding written there anyway is READ but not applied, and logged. Silently
  // honouring it would make one folder disagree with the store it lives in;
  // silently dropping it leaves a binding the user can neither see nor act on.
  const { cleanup } = useTestDataDir("binding-project-node");
  try {
    __resetMethodsForTest();
    registerMethod(SPEC_KIT);
    registerMethod(OTHER);
    await ensureStores();

    const root = join(specsRoot(), "user-specs");
    write(root, "pinned/project.json", JSON.stringify({ label: "Pinned", method: "other" }));
    write(root, "pinned/001-a/spec.md", "# A\n");
    write(root, "plain/project.json", JSON.stringify({ label: "Plain" }));
    write(root, "plain/001-b/spec.md", "# B\n");

    expect((await listProjects("user-specs")).find((p) => p.id === "pinned")?.method).toBe("other");

    const { specTree } = await import("../../src/lib/specs/pipeline");
    const group = (await specTree()).find((g) => g.name === "user-specs");
    const pinned = group?.children?.find((n) => n.name === "pinned");
    const plain = group?.children?.find((n) => n.name === "plain");

    // The binding is still READ from the manifest — it is not deleted from the
    // user's file — it is simply not honoured here, and a warning names it.
    expect(pinned?.method, "resolves to the STORE's method, not the project's").toBe(DEFAULT_METHOD_ID);
    expect(plain?.method).toBe(DEFAULT_METHOD_ID);
    expect(group?.bindingScope, "and the tree says why, so the UI offers no picker here").toBe("store");
  } finally {
    __resetMethodsForTest();
    cleanup();
  }
});

test("an uninstalled method names WHERE the binding came from", async () => {
  // "Store X is bound to method Y" sends you to X's manifest. When the id came
  // from the global default it is not there — and a log line that points at the
  // wrong file costs more than one that says nothing. Checking a real instance
  // of this took a search of every commit of the store's manifest to disprove.
  __resetMethodsForTest();
  registerMethod(SPEC_KIT);

  const grab = (binding: Parameters<typeof resolveMethod>[0]): string => {
    try {
      resolveMethod(binding, "user-specs");
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  };

  expect(grab({ store: "openspec" }), "a real store binding blames the store").toContain("is bound to");
  const viaDefault = grab({ globalDefault: "openspec" });
  expect(viaDefault, "a global default must NOT claim the store is bound").not.toContain("is bound to");
  expect(viaDefault).toContain("global default");
  expect(viaDefault, "and must say where NOT to look").toContain("NOT in this store's manifest");
  expect(grab({ project: "openspec" })).toContain("project");
});

test("a store bound by WORKFLOW resolves — the field was written and never read", async () => {
  // 049 FR-009 made `workflow` supersede `method`, and 050 added it to the
  // store manifest. Store-level resolution still read `store.method` alone, so
  // a store bound by workflow resolved as if it were unbound — silently, since
  // falling back to spec-kit looks exactly like never having bound anything.
  //
  // Found by collapsing four hand-assembled binding chains into one: reading
  // them side by side is what made the omission visible.
  const { cleanup } = useTestDataDir("binding-store-workflow");
  try {
    __resetMethodsForTest();
    registerMethod(SPEC_KIT);
    registerMethod(OTHER);
    await ensureStores();

    const dir = join(specsRoot(), "user-specs");
    const manifest = JSON.parse(readFileSync(join(dir, "spec-store.json"), "utf8"));
    writeFileSync(join(dir, "spec-store.json"), JSON.stringify({ ...manifest, workflow: "other" }, null, 2));

    const { methodForStore } = await import("../../src/lib/specs/pipeline");
    expect((await methodForStore("user-specs")).id, "the workflow binding is honoured").toBe("other");
  } finally {
    __resetMethodsForTest();
    cleanup();
  }
});

test("a QUALIFIED workflow binding resolves — the form registration actually writes", async () => {
  // Registration writes `wf.qualified` ("spec-kit:spec-kit"), and resolveMethod
  // did getMethod() on it — which only knows METHOD ids. So a freshly cloned
  // repository reported "bound to spec method 'unknown', which is not
  // installed" and rendered with no folders at all, naming a pack that was
  // installed the whole time.
  //
  // The earlier test for this used `workflow: "other"` — a bare name that is
  // ALSO a method id, so it passed through getMethod and proved nothing about
  // the qualified form. A value that works both ways tests neither.
  __resetMethodsForTest();
  registerMethod(SPEC_KIT);
  registerMethod({ ...OTHER, workflows: [{ id: "enterprise", default: true }, { id: "simple" }] });

  expect(resolveMethod({ store: "other:enterprise" }, "s").id, "qualified").toBe("other");
  expect(resolveMethod({ store: "simple" }, "s").id, "bare workflow name").toBe("other");
  expect(resolveMethod({ store: "other" }, "s").id, "bare METHOD id still works").toBe("other");
  expect(resolveMethod({ store: "spec-kit" }, "s").id, "and so does every pre-existing binding").toBe("spec-kit");

  // Still refused when genuinely absent, and still names the source.
  let err: Error | undefined;
  try { resolveMethod({ globalDefault: "nope:nope" }, "user-specs"); } catch (e) { err = e as Error; }
  expect(err, "an unknown workflow is not quietly resolved").toBeDefined();
  expect(err!.message).toContain("global default");
  __resetMethodsForTest();
});
