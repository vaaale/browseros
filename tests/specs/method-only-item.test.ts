// 045 — a METHOD-ONLY marketplace entry must survive BOS's manifest reconcile.
//
// This is not a hypothetical. Installing the OpenSpec pack produced only an
// "Adopt spec" button: `hasAnyFacet` did not count `method`, so the curated
// entry was judged to describe nothing, PRUNED from the user's own repo, and
// re-added as a stub synthesised from the disk scan — losing its name,
// description, tags and the entire `method` block. BOS then COMMITTED that.
//
// BMAD never hit it because it also declares an `integration`. OpenSpec is the
// first method-ONLY pack, and the first to expose the gap.
//   npm run test:unit -- tests/specs/method-only-item.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { useTestDataDir } from "../services/_test-env";
import { listCatalog } from "../../src/lib/marketplace/client";

/** The user's own marketplace, carrying a curated method-only entry. */
function layOutMethodOnlyItem(dataDir: string): string {
  const root = join(dataDir, "user-apps");
  const item = join(root, "items", "openspec");
  mkdirSync(join(item, "method"), { recursive: true });
  writeFileSync(join(item, "method", "method.json"), JSON.stringify({
    schemaVersion: 1, id: "openspec", label: "OpenSpec", version: "1.13.0",
    sections: [{ rel: "changes", kind: "active", leafMarker: "proposal.md", numbering: "none" }],
    constitution: "config.yaml", constitutionRoot: "own",
    discrepancies: { rel: "discrepancies.md", roots: ["own"] },
    artifacts: [{ id: "proposal.md", generates: "proposal", requires: [] }],
    artifactOrder: ["proposal.md"],
    phases: [{ id: "proposal", label: "Proposal", requires: [], rules: [{ when: { kind: "nonEmpty", file: { rel: "proposal.md" } }, then: "done" }] }],
    stateLabels: { done: "Done", pending: "Available", blocked: "Blocked", na: "—" },
    templates: "templates", storeRoot: "openspec", agents: [], roles: {},
  }));
  // A spec facet too — the pack documents itself. This is what the scanner CAN
  // see, and what it replaced the real entry with.
  mkdirSync(join(item, "spec"), { recursive: true });
  writeFileSync(join(item, "spec", "spec.md"), "# OpenSpec pack\n");

  const manifest = {
    id: "user-apps", name: "My Apps", version: "1.0.0", description: "mine",
    items: [{
      id: "openspec",
      name: "OpenSpec",
      description: "The lightweight, brownfield-first alternative to spec-kit.",
      tags: ["method"],
      method: { id: "openspec", version: "1.13.0", schemaVersion: 1 },
    }],
  };
  writeFileSync(join(root, "marketplace.json"), JSON.stringify(manifest, null, 2) + "\n");
  return root;
}

test("a method-only entry survives the reconcile with its declaration intact", async () => {
  const { dir, cleanup } = useTestDataDir("method-only-entry");
  try {
    const root = layOutMethodOnlyItem(dir);
    // listCatalog() is the path the Marketplace app itself calls — the repeated
    // lesson of this feature family is that testing a helper the product does
    // not call proves nothing about the product.
    const catalog = await listCatalog();
    const local = catalog.find((m) => m.id === "user-apps");
    const entry = local?.items.find((i) => i.id === "openspec");
    expect(entry, "the entry must not be pruned — a method IS an installable facet").toBeDefined();
    expect(entry!.method, "the method block is what the Install button is gated on (045 FR-012a)")
      .toEqual({ id: "openspec", version: "1.13.0", schemaVersion: 1 });

    // Curation the scanner cannot reproduce must not be lost. These came back
    // as "Openspec" / "" when the entry was pruned and re-synthesised.
    expect(entry!.name).toBe("OpenSpec");
    expect(entry!.description).toContain("brownfield-first");

    // And the file on disk must agree — the reconcile WRITES and COMMITS.
    const onDisk = JSON.parse(readFileSync(join(root, "marketplace.json"), "utf8")) as { items: Array<{ id: string; name?: string; method?: unknown }> };
    const written = onDisk.items.find((i) => i.id === "openspec");
    expect(written?.method, "a rewrite must not delete it from the user's repo").toBeDefined();
    expect(written?.name).toBe("OpenSpec");
  } finally {
    cleanup();
  }
});

test("installing a method-ONLY item creates its item link and registers the pack", async () => {
  // The install reported success and registered nothing. Two faults in one
  // place: no code path created the item symlink for a method-only pack (the
  // app branch links iframe apps, services copy, plugins have their own path —
  // which is why BMAD, carrying an integration, worked), and the method branch
  // was wrapped in `if (installed)`, so the absence was a SILENT no-op rather
  // than an error. The UI then showed "Installed" for a pack that was not.
  const { dir, cleanup } = useTestDataDir("method-only-install");
  try {
    layOutMethodOnlyItem(dir);
    const { installMarketplaceItem } = await import("../../src/lib/marketplace/client");
    const { listInstalledItems } = await import("../../src/system/items/installed");

    await installMarketplaceItem("user-apps", "openspec");

    // 035: installing IS the symlink. Without it nothing downstream can find
    // the pack, and the Marketplace cannot mark the item installed.
    expect(existsSync(join(dir, "system", "openspec")), "the item link is the install").toBe(true);
    expect((await listInstalledItems()).map((i) => i.id), "and the UI reads installed state from this").toContain("openspec");
  } finally {
    cleanup();
  }
});
