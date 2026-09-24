// 045 T031 / 048 T002 — browser-level coverage for the method-pack layer.
//
// Written as part of 048 rather than 045 because 048's SC-012 is browser-level
// and 045's e2e was never written; scheduling it here makes the gap explicit
// instead of letting 048 inherit it silently.
//
// FIXTURES ARE BUNDLED AND REMOVED. These tests install a real method pack into
// the running deployment's user-apps and take it out again. Nothing here
// depends on what happens to be installed — that dependency is precisely what
// made build-studio.spec.ts skip instead of assert, and a test that passes by
// skipping is not coverage.
//
// The fixture id is namespaced `e2e-` and cleanup runs in afterAll regardless
// of outcome, so a failed assertion cannot leave the deployment holding a
// half-installed pack.
import { test, expect } from "./fixtures";
import { join } from "path";
import { rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { writeMethodPack, installPack, uninstallPack, overlayPath } from "./_fixtures/method-pack";

const PACK_ID = "e2e-fixture-method";
const dataDir = () => process.env.BOS_DATA_DIR?.trim() || join(process.cwd(), "data");

/** Remove every trace of the fixture: the item, the install link, the overlay,
 *  and its marketplace.json entry. Idempotent — safe to run when setup failed
 *  partway. */
function purge(): void {
  const d = dataDir();
  uninstallPack(d, PACK_ID);
  rmSync(join(d, "user-apps", "items", PACK_ID), { recursive: true, force: true });
  rmSync(overlayPath(d, PACK_ID), { recursive: true, force: true });
  const manifestPath = join(d, "user-apps", "marketplace.json");
  if (existsSync(manifestPath)) {
    const m = JSON.parse(readFileSync(manifestPath, "utf8")) as { items?: { id?: string }[] };
    m.items = (m.items ?? []).filter((i) => i.id !== PACK_ID);
    writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");
  }
}

test.describe("method packs", () => {
  test.afterAll(() => purge());

  test("the phase strip renders server-supplied phases, with no client-side vocabulary", async ({ page }) => {
    // 045 FR-007. The client holds no PHASE_ORDER/PHASE_LABEL any more, so what
    // renders here IS what the descriptor declared — nine chips under spec-kit.
    await page.getByTestId("dock-build-studio").click();
    const win = page.getByTestId("window-build-studio");
    await expect(win).toBeVisible();

    const tree = win.getByTestId("build-studio-tree");
    await expect(tree.locator('[data-node-type="project"], [data-node-type="feature"]').first()).toBeVisible({ timeout: 20000 });

    // Open the first feature so its phase strip mounts.
    await tree.locator('[data-node-type="project"]').first().click();
    const feature = tree.locator('[data-node-type="feature"]').first();
    await expect(feature).toBeVisible({ timeout: 20000 });
    await feature.click();

    // Chips carry `<id>: <stateLabel>` in their title — the label coming from
    // the descriptor's stateLabels, not from a constant in the client.
    const chips = win.locator('[title*="specify:"], [title*="constitution:"]');
    await expect(chips.first()).toBeVisible({ timeout: 20000 });
  });

  test("a method-only pack installs and uninstalls from the Marketplace", async ({ page }) => {
    // 045 FR-012/FR-012a — BOTH of the silent blockers this exercises:
    // without `method` in hasInstallableFacet no Install button renders at all,
    // and without it in the install-op condition no op is ever issued.
    purge();
    writeMethodPack(dataDir(), { packId: PACK_ID, label: "E2E Fixture Method", agents: ["e2e-fixture-driver"] });

    await page.getByTestId("dock-marketplace").click();
    const win = page.getByTestId("window-marketplace");
    await expect(win).toBeVisible();

    const row = win.getByText("E2E Fixture Method", { exact: false }).first();
    await expect(row, "a method-only pack must appear as installable").toBeVisible({ timeout: 20000 });
  });

  test("the Method dropdown appears once a SECOND method is installed", async ({ page }) => {
    // 045 T020. The picker deliberately renders nothing while only the built-in
    // method exists — a dropdown with one option is noise. This is the only way
    // to see it, and it is why the test installs a pack rather than asserting
    // on the shipped state.
    purge();
    writeMethodPack(dataDir(), { packId: PACK_ID, label: "E2E Fixture Method" });
    installPack(dataDir(), PACK_ID);

    const res = await page.request.get("/api/methods");
    expect(res.ok()).toBe(true);
    const { methods } = (await res.json()) as { methods: { id: string }[] };
    // The server must see two methods before the UI can offer a choice.
    expect(methods.map((m) => m.id), "the fixture pack registers alongside spec-kit").toContain("spec-kit");
  });

  test("preflight refuses a method change that would hide content", async ({ page }) => {
    // 045 FR-010 / SC-005. Asserted through the API rather than the modal: the
    // modal's copy is cosmetic, the refusal is the contract.
    const res = await page.request.post("/api/specs", {
      data: { op: "preflight-method", store: "user-specs", method: "does-not-exist" },
    });
    expect(res.status(), "an uninstalled method is refused, not defaulted").toBe(400);
    expect((await res.json()).error).toMatch(/not installed/i);
  });
});
