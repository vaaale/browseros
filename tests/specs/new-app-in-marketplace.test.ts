// REPRODUCTION: right-click "USER APPS" → New app → `Unknown spec store "user-apps"`.
//
// The marketplace has no store of its own — `listStores()` yields `item-<id>`
// stores, one per installed item, never the repo that holds them. `lifecycle.ts`
// therefore SYNTHESISES it (`localMarketplaceStore()`, id `user-apps`) so that
// "create a project in the marketplace" — i.e. make a new app — is reachable at
// all, and says so in a comment: "synthesised here rather than left unreachable".
//
// `POST /api/specs` then re-checks the store itself, against `listStores()`,
// before dispatching to that very code:
//
//     const store = (await listStores()).find((s) => s.id === storeId);
//     if (!store) return 400 `Unknown spec store "${storeId}"`;
//
// One rule, two implementations, only one of them synthesising — so the door is
// shut on the one op the synthesis exists for. Build Studio's own comment
// ("it mirrors the single place lifecycle.ts synthesises the same store
// server-side") describes a mirror that was never actually there.
//
// Also covered: an item's row is titled by the item's NAME, not by its spec's
// H1. bmad's spec came from BOS's own 048 feature spec, so its H1 reads
// "Feature Specification: The BMAD pack — a framework that brings its own cast
// and its own runtime" — and the sidebar showed THAT as the app's name, which
// reads as a mystery app nobody created.
//
//   npm run test:unit -- tests/specs/new-app-in-marketplace.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync, symlinkSync } from "fs";
import { execFileSync } from "child_process";
import { NextRequest } from "next/server";
import { useTestDataDir } from "../services/_test-env";
import { POST } from "../../src/app/api/specs/route";
import { readFileSync } from "fs";
import { listSpecifications, specTree } from "../../src/lib/specs/pipeline";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
}

/** A marketplace with one installed item whose spec H1 is NOT its name — the
 *  bmad case, and the only reason the mismatch is visible at all. */
function layOutMarketplace(dataDir: string): void {
  const apps = join(dataDir, "user-apps");
  mkdirSync(join(apps, "items", "bmad", "spec"), { recursive: true });
  git(apps, ["init", "-q", "-b", "main"]);
  writeFileSync(
    join(apps, "marketplace.json"),
    JSON.stringify({ id: "user-apps", name: "My Apps", version: "1.0.0", items: [{ id: "bmad", name: "BMAD Method", app: { entrypoint: "app/index.html", runtime: "iframe" } }] }, null, 2),
  );
  writeFileSync(
    join(apps, "items", "bmad", "spec", "spec.md"),
    "# Feature Specification: The BMAD pack — a framework that brings its own cast and its own runtime\n",
  );
  mkdirSync(join(dataDir, "system"), { recursive: true });
  symlinkSync(join(apps, "items", "bmad"), join(dataDir, "system", "bmad"));
  git(apps, ["add", "-A"]);
  git(apps, ["commit", "-q", "-m", "items"]);
}

async function specsPost(body: Record<string, unknown>) {
  const res = await POST(
    new NextRequest("http://localhost/api/specs", { method: "POST", body: JSON.stringify(body) }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

test("New app in the marketplace is not refused as an unknown store", async () => {
  const { dir: dataDir, cleanup } = useTestDataDir("new-app-marketplace");
  try {
    layOutMarketplace(dataDir);

    // Exactly what Build Studio's "New app…" sends: the synthetic marketplace
    // row's own id (index.tsx's `marketplaceRow`, path "user-apps").
    const { status, json } = await specsPost({
      op: "create-project",
      store: "user-apps",
      name: "Follow the Money",
      branch: "bos/testfixture-follow-the-money",
    });

    expect(status, `the marketplace store must be reachable: ${JSON.stringify(json)}`).toBe(200);
    const project = json.project as { id?: string; unit?: string } | undefined;
    expect(project?.unit, "a marketplace's projects ARE its items").toBe("item");
    expect(project?.id).toBeTruthy();
  } finally {
    cleanup();
  }
});

test("the sidebar labels an item by the APP's name, not its spec's H1", async () => {
  const { dir: dataDir, cleanup } = useTestDataDir("new-app-marketplace");
  try {
    layOutMarketplace(dataDir);

    // The Specification's title IS the spec's H1 — that is the spec's own title
    // and item-stores.test.ts asserts it deliberately. What must not happen is
    // the SIDEBAR using it: an installed app's row is the app, identified by the
    // name in the marketplace manifest and in its `data/system/<id>` link.
    const group = (await specTree()).find((g) => g.path === "item-bmad");
    expect(group?.label).toBe("BMAD Method");
    // The synthetic row is what the sidebar actually draws (item groups are
    // flattened under one "User Apps" heading), so it has to carry it too.
    expect(group?.children?.[0]?.name).toBe("BMAD Method");
    expect(group?.children?.[0]?.owner).toBe("item");

    const spec = (await listSpecifications()).find((s) => s.store === "item-bmad");
    expect(spec!.title, "the SPEC keeps its own title").toBe(
      "The BMAD pack — a framework that brings its own cast and its own runtime",
    );
  } finally {
    cleanup();
  }
});

test("the row renders the item's own name rather than the spec title", async () => {
  // renderNode is client-side and out of this suite's reach, and the preference
  // it encodes is the bug — the same shape as the store-header badge, where every
  // server-side assertion passed while the screen stayed wrong.
  const src = readFileSync("src/apps/build-studio/index.tsx", "utf8");
  const block = src.slice(src.indexOf("const label = isForeignDraft"), src.indexOf("const label = isForeignDraft") + 420);
  expect(block, "an item row must short-circuit to the item's name").toContain('node.owner === "item"');
});

test("the method chosen in the dialog is BOUND to the app at birth", async () => {
  const { dir: dataDir, cleanup } = useTestDataDir("new-app-marketplace");
  try {
    layOutMarketplace(dataDir);
    // spec-kit is registered from BOS's own pack; a bare fixture has an empty
    // registry, and the route correctly refuses a workflow that does not exist.
    const { ensureBuiltinMethod } = await import("../../src/lib/specs/method/resolve");
    ensureBuiltinMethod();

    // The dialog now asks for name + method up front and passes the method
    // through as `workflow`. Binding AFTERWARDS is what orphans the first
    // artifact — it was written under the old method's leaf marker and the new
    // one does not discover it — so this has to land as part of creation.
    const { status, json } = await specsPost({
      op: "create-project",
      store: "user-apps",
      name: "Follow the Money",
      workflow: "spec-kit",
      branch: "bos/testfixture-follow-money",
    });
    expect(status, `create with a method must be accepted: ${JSON.stringify(json)}`).toBe(200);

    const id = (json.project as { id: string }).id;
    const manifest = JSON.parse(
      readFileSync(join(dataDir, "user-apps", "items", id, "spec", "spec-store.json"), "utf8"),
    ) as { workflow?: string };
    expect(manifest.workflow, "the app records the method it was created with").toBeTruthy();
    expect(String(manifest.workflow)).toContain("spec-kit");
  } finally {
    cleanup();
  }
});
