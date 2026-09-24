// REPRODUCTION: an app created with BMAD selected reports spec-kit.
//
// Two independent breaks, same symptom, and either one alone is enough:
//
// 1. THE WRITE. `createItemSpec` takes a `workflow` and uses it for ONE thing —
//    the primary artifact's name — and never records it. Only `createProjectIn`
//    (Build Studio's dialog) binds afterwards, via setItemWorkflow. The agent
//    calls `app_spec_create`, which has no workflow parameter AT ALL, so an app
//    the user asked for "using the BMAD method" is created with no binding and
//    resolves to the global default. The live item on the box has no
//    spec-store.json at all:
//        items/follow-the-money/spec/{spec.md,product-brief.md}
//    — a BMAD product-brief sitting in a store BOS believes is spec-kit.
//
// 2. THE READ. `setItemWorkflow` writes `workflow`; `readItemMethod` reads
//    `method`. The binding chain reads `store.workflow ?? store.method`, and an
//    item store can only ever populate `method` — so even the Build Studio path,
//    which DOES bind, writes a key the reader does not look at. One field, two
//    spellings, no error either way.
//
//   npm run test:unit -- tests/specs/item-method-binding.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync } from "fs";
import { execFileSync } from "child_process";
import { useTestDataDir } from "../services/_test-env";
import { registerMethod, __resetMethodsForTest } from "../../src/lib/specs/method/registry";
import { loadBuiltinDescriptor } from "../../src/lib/specs/method/builtin-pack";
import { METHOD_SCHEMA_VERSION, type MethodDescriptor } from "../../src/lib/specs/method/types";
import { specTree } from "../../src/lib/specs/pipeline";
import { createItemSpec } from "../../src/lib/specs/create";
import { itemSpecTools } from "../../src/lib/assistant/tools/server/specs";
import { STORE_MANIFEST } from "../../src/lib/specs/stores";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
}

/** A second installed method, so "which method is this item on" has a wrong
 *  answer to give. With only spec-kit registered, the default and the binding
 *  agree by accident and neither break is visible. */
const BMAD: MethodDescriptor = {
  schemaVersion: METHOD_SCHEMA_VERSION,
  id: "bmad",
  label: "BMAD",
  version: "1.0.0",
  sections: [{ rel: "", kind: "active", leafMarker: "spec.md", numbering: "nnn-slug" }],
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

function methods(): void {
  __resetMethodsForTest();
  registerMethod(loadBuiltinDescriptor()); // spec-kit — the global default
  registerMethod(BMAD);
}

/** A user-apps repo on a branch, ready to be written to. With no Supervisor the
 *  branch IS the checkout's HEAD (item-stores.test.ts's own note). */
function layOutUserApps(dataDir: string, branch: string): string {
  const apps = join(dataDir, "user-apps");
  mkdirSync(apps, { recursive: true });
  git(apps, ["init", "-q", "-b", "main"]);
  writeFileSync(
    join(apps, "marketplace.json"),
    JSON.stringify({ id: "user-apps", name: "My Apps", version: "1.0.0", items: [] }, null, 2),
  );
  git(apps, ["add", "-A"]);
  git(apps, ["commit", "-q", "-m", "init"]);
  git(apps, ["checkout", "-q", "-b", branch]);
  return apps;
}

/** An item laid down directly, with whatever binding manifest the case needs. */
function layOutItem(dataDir: string, id: string, manifest: Record<string, unknown> | null): void {
  const itemPath = join(dataDir, "user-apps", "items", id);
  mkdirSync(join(itemPath, "spec"), { recursive: true });
  writeFileSync(join(itemPath, "spec", "spec.md"), `# ${id}\n`);
  if (manifest) writeFileSync(join(itemPath, "spec", STORE_MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
  mkdirSync(join(dataDir, "system"), { recursive: true });
  symlinkSync(itemPath, join(dataDir, "system", id));
}

const BRANCH = "bos/testfixture-follow-the-money";

test("an item bound by `workflow` reports that method, not the default", async () => {
  const { dir, cleanup } = useTestDataDir("item-binding-read");
  try {
    methods();
    layOutUserApps(dir, BRANCH);
    // EXACTLY what setItemWorkflow writes — the key the binding chain reads
    // (`store.workflow ?? store.method`) and the one an item store never filled.
    layOutItem(dir, "follow-the-money", { workflow: "bmad" });

    const group = (await specTree()).find((g) => g.path === "item-follow-the-money");
    expect(group?.method, "the method the item is bound to").toBe("bmad");
    expect(group?.methodBound, "and it is a real binding, not an inherited default").toBe(true);
  } finally {
    cleanup();
  }
});

test("`method` keeps working — the older spelling is not dropped", async () => {
  const { dir, cleanup } = useTestDataDir("item-binding-read-legacy");
  try {
    methods();
    layOutUserApps(dir, BRANCH);
    layOutItem(dir, "legacy-app", { method: "bmad" });

    const group = (await specTree()).find((g) => g.path === "item-legacy-app");
    expect(group?.method).toBe("bmad");
    expect(group?.methodBound).toBe(true);
  } finally {
    cleanup();
  }
});

test("an unbound item still reports the default — a binding is not invented", async () => {
  const { dir, cleanup } = useTestDataDir("item-binding-unbound");
  try {
    methods();
    layOutUserApps(dir, BRANCH);
    layOutItem(dir, "plain-app", null);

    const group = (await specTree()).find((g) => g.path === "item-plain-app");
    expect(group?.method, "the global default").toBe("spec-kit");
    expect(group?.methodBound, "inherited, so the picker must not claim it was chosen").toBe(false);
  } finally {
    cleanup();
  }
});

test("createItemSpec RECORDS the method it created the item under", async () => {
  const { dir, cleanup } = useTestDataDir("item-binding-create");
  try {
    methods();
    layOutUserApps(dir, BRANCH);

    // The method decides the primary artifact's NAME, which is why it is passed
    // at creation at all. Recording it is the other half of the same fact: an
    // item whose first artifact was written under BMAD but which reports
    // spec-kit is a store that disagrees with its own contents.
    const { id } = await createItemSpec({
      name: "Follow the Money",
      specBody: "# Follow the Money\n",
      workflow: "bmad",
      branch: BRANCH,
    });

    const manifestPath = join(dir, "user-apps", "items", id, "spec", STORE_MANIFEST);
    expect(existsSync(manifestPath), `the item must record its method at ${manifestPath}`).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { workflow?: string };
    expect(String(manifest.workflow), "bound to the method it was created under").toContain("bmad");

    const group = (await specTree()).find((g) => g.path === `item-${id}`);
    expect(group?.method, "and the tree reads back what was written").toBe("bmad");
    expect(group?.methodBound).toBe(true);
  } finally {
    cleanup();
  }
});

test("app_spec_create — the AGENT's path — can say which method", async () => {
  // The agent is how apps actually get created ("build an app using the BMAD
  // method"); Build Studio's dialog is the path that already had this. A tool
  // with no way to express the method cannot produce a bound item no matter
  // what the user asked for.
  const params = itemSpecTools().app_spec_create.parameters as {
    properties?: Record<string, unknown>;
  };
  expect(Object.keys(params.properties ?? {}), "app_spec_create must accept the method").toContain("workflow");
});

test("creating with an UNKNOWN method is refused, not silently defaulted", async () => {
  const { dir, cleanup } = useTestDataDir("item-binding-unknown");
  try {
    methods();
    layOutUserApps(dir, BRANCH);

    // A typo'd method that quietly became spec-kit is precisely the failure
    // being fixed — it has to be louder than the thing it replaces.
    await expect(
      createItemSpec({ name: "Typo App", specBody: "# Typo\n", workflow: "bmadd", branch: BRANCH }),
    ).rejects.toThrow(/bmadd/);
    expect(existsSync(join(dir, "user-apps", "items", "typo-app")), "and nothing is created").toBe(false);
  } finally {
    cleanup();
  }
});
