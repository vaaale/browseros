// 045/046 FR-016 — an unresolvable method must not blank the whole sidebar.
//
// /api/specs resolves tree + specs + descriptor in ONE Promise.all, so any
// rejection fails all three and Build Studio renders "Could not load specs" with
// an empty tree. A store bound to an uninstalled method is a real, expected
// state (uninstall the pack, restart) — and making it take down every OTHER
// store with it is indistinguishable, from the user's side, from their specs
// having been deleted.
//   npm run test:unit -- tests/specs/method-failure-containment.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { readFileSync, writeFileSync } from "fs";
import { useTestDataDir } from "../services/_test-env";
import { specsRoot } from "../../src/os/specs-dir";
import { ensureStores } from "../../src/lib/specs/seed";
import { specTree, listSpecifications, activeMethodSummary } from "../../src/lib/specs/pipeline";

/** Bind one store to a method that is definitely not installed. */
function bindToMissingMethod(storeId: string, methodId: string): void {
  const f = join(specsRoot(), storeId, "spec-store.json");
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), method: methodId }, null, 2));
}

test("a store bound to an uninstalled method still RENDERS, carrying the reason", async () => {
  const { cleanup } = useTestDataDir("method-missing-group");
  try {
    await ensureStores();
    bindToMissingMethod("user-specs", "openspec");

    const tree = await specTree();
    const userSpecs = tree.find((g) => g.name === "user-specs");

    expect(userSpecs, "the group must not vanish — a missing group reads as data loss").toBeDefined();
    expect(userSpecs?.methodMissing, "and it must name the method that is missing").toBe("openspec");
    expect(userSpecs?.writable, "it cannot be written under a method BOS cannot interpret").toBe(false);
  } finally {
    cleanup();
  }
});

test("the OTHER stores are unaffected — containment, not a global failure", async () => {
  const { cleanup } = useTestDataDir("method-missing-containment");
  try {
    await ensureStores();
    bindToMissingMethod("user-specs", "openspec");

    // Exactly what GET /api/specs does. Before containment, ANY of these three
    // rejecting produced a 400 and an empty sidebar.
    const [tree, specs, method] = await Promise.all([specTree(), listSpecifications(), activeMethodSummary()]);

    expect(tree.map((g) => g.name), "bos-system-specs resolves fine and must still appear").toContain("bos-system-specs");
    const system = tree.find((g) => g.name === "bos-system-specs");
    expect(system?.methodMissing, "a healthy store carries no marker").toBeUndefined();

    // specs/method degrade rather than reject.
    expect(Array.isArray(specs)).toBe(true);
    void method;
  } finally {
    cleanup();
  }
});

test("activeMethodSummary degrades to undefined instead of rejecting", async () => {
  // It is one of three Promise.all arms; a rejection here takes the tree with
  // it even though the tree itself resolved perfectly.
  const { cleanup } = useTestDataDir("method-missing-summary");
  try {
    await ensureStores();
    bindToMissingMethod("user-specs", "definitely-not-installed");
    await expect(activeMethodSummary()).resolves.toBeUndefined();
  } finally {
    cleanup();
  }
});
