import { test, expect } from "./fixtures";
import { join } from "path";
import { mkdirSync, writeFileSync, symlinkSync, rmSync } from "fs";

// 048 T002 — an item with a `spec/` facet, so the "grouped under User Apps"
// assertion below has something to assert on regardless of what the deployment
// has installed. Namespaced `e2e-` and removed in afterAll.
const ITEM_ID = "e2e-fixture-spec-item";
const dataDir = () => process.env.BOS_DATA_DIR?.trim() || join(process.cwd(), "data");

function writeSpecItem(): void {
  const p = join(dataDir(), "user-apps", "items", ITEM_ID);
  mkdirSync(join(p, "spec"), { recursive: true });
  writeFileSync(join(p, "spec", "spec.md"), "# E2E fixture item\n\nBundled by build-studio.spec.ts.\n");
  mkdirSync(join(dataDir(), "system"), { recursive: true });
  rmSync(join(dataDir(), "system", ITEM_ID), { force: true });
  symlinkSync(p, join(dataDir(), "system", ITEM_ID));
}

function purgeSpecItem(): void {
  rmSync(join(dataDir(), "system", ITEM_ID), { force: true });
  rmSync(join(dataDir(), "user-apps", "items", ITEM_ID), { recursive: true, force: true });
}

// Deterministic smoke test for the Build Studio app. Asserts the window opens and
// the spec tree renders the in-repo 001-build-studio feature. Never asserts on
// (nondeterministic) assistant/LLM output.
test.describe("Build Studio", () => {
  test.beforeAll(() => writeSpecItem());
  test.afterAll(() => purgeSpecItem());

  test("opens from the dock and shows the spec tree", async ({ page }) => {
    await page.getByTestId("dock-build-studio").click();
    const win = page.getByTestId("window-build-studio");
    await expect(win).toBeVisible();
    // Every container (project/dir/feature) starts collapsed, so a file leaf
    // never renders without expanding first — wait for a top-level row
    // instead, which always renders once the tree loads (the Project layer's
    // recursive tree walk over every feature can take several seconds, well
    // past the default 5s assertion timeout).
    await expect(win.getByTestId("build-studio-tree").locator('[data-node-type="project"], [data-node-type="feature"]').first()).toBeVisible({ timeout: 20000 });
    // The embedded assistant chat (pinned to the Build Studio agent) mounted.
    await expect(win.getByRole("textbox").first()).toBeVisible();
  });

  test("the spec-tree side panel resizes by dragging its divider", async ({ page }) => {
    await page.getByTestId("dock-build-studio").click();
    const win = page.getByTestId("window-build-studio");
    await expect(win).toBeVisible();

    const tree = win.getByTestId("build-studio-tree");
    await expect(tree).toBeVisible();
    const before = (await tree.boundingBox())!;

    // The divider sits immediately to the right of the tree pane. Drag it right.
    const x = before.x + before.width + 2;
    const y = before.y + before.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 90, y, { steps: 8 });
    await page.mouse.up();

    const after = (await tree.boundingBox())!;
    expect(after.width).toBeGreaterThan(before.width + 40);
  });

  test("installed marketplace items are grouped under one 'User Apps' heading, with a working file context menu", async ({ page }) => {
    await page.getByTestId("dock-build-studio").click();
    const win = page.getByTestId("window-build-studio");
    await expect(win).toBeVisible();
    const tree = win.getByTestId("build-studio-tree");
    await expect(tree.locator('[data-node-type="project"], [data-node-type="feature"]').first()).toBeVisible({ timeout: 20000 });

    // 048 T002 converted this off a skip. It used to bail with
    // `test.skip(true, "no marketplace item installed in this environment")`
    // whenever the deployment happened to have no item with a spec facet —
    // which meant it asserted NOTHING on a clean install, and a test that
    // passes by skipping is not coverage. It is also the pre-seeded-data
    // dependency docs/dev/testing.md prohibits.
    //
    // The fixture is created in beforeAll and removed in afterAll, so the
    // assertion below always runs and never depends on ambient state.
    const itemFeature = tree.locator('[data-node-type="feature"][data-key^="item-"]').first();
    await expect(itemFeature, "the bundled item fixture must be present").toBeVisible({ timeout: 20000 });

    await expect(tree.getByText("User Apps", { exact: true })).toBeVisible();
    await itemFeature.scrollIntoViewIfNeeded();
    await itemFeature.click(); // expand it — collapsed by default
    const itemFile = tree.locator('[data-node-type="file"][data-key^="item-"]').first();
    await itemFile.scrollIntoViewIfNeeded();
    await itemFile.click({ button: "right" });
    await expect(page.getByRole("button", { name: "View history", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Rename", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
  });
});
