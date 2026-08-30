import { test, expect } from "./fixtures";

// Deterministic smoke test for the Build Studio app. Asserts the window opens and
// the spec tree renders the in-repo 001-build-studio feature. Never asserts on
// (nondeterministic) assistant/LLM output.
test.describe("Build Studio", () => {
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

    // Whether any marketplace item is installed depends on the environment's
    // data (not something this test creates) — skip gracefully rather than
    // asserting on it, but if one IS present, its store must be grouped under
    // "User Apps" (not its own top-level category) and its files must offer
    // the same context menu as any other spec file, not none at all.
    const itemFeature = tree.locator('[data-node-type="feature"][data-key^="item-"]').first();
    if ((await itemFeature.count()) === 0) {
      test.skip(true, "no marketplace item installed in this environment");
      return;
    }

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
