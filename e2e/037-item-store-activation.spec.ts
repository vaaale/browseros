import { test, expect, type Page, type Locator } from "./fixtures";

// End-to-end coverage for item-owned store activation in Build Studio: an
// installed marketplace item's own row (isItemFeatureNode, not a file inside
// it) drives the PRE-EXISTING Supervisor app-candidate mechanism — the same
// one VersionControls.tsx's "Promote app"/"Discard app" buttons already use
// for app/service CODE. Right-click offers Activate (one click, no branch
// name — app-candidate's branch is Supervisor-managed) when inactive, or
// Promote/Discard once active. No bespoke branch/worktree scheme (the
// item-store-git.ts built for this earlier was retired — it duplicated this
// exact mechanism on the same data/user-apps repo).
//
// An item store only exists once a real item is installed — not something
// creatable through a plain spec-content API call. Rather than mutating the
// developer's real data/user-apps repo to manufacture one, this test stubs
// /api/specs and the Supervisor's /__supervisor/* surface entirely — same
// approach already used for exactly this "don't depend on whatever's
// actually installed" concern in 036-marketplace-master-detail.spec.ts.

function itemTree() {
  return {
    tree: [
      {
        type: "group",
        name: "item-widget",
        label: "Widget",
        path: "item-widget",
        owner: "item",
        writable: true,
        children: [{ type: "feature", name: "Widget", path: "item-widget", children: [{ type: "file", name: "spec.md", path: "item-widget/spec.md" }] }],
      },
    ],
    specs: [],
  };
}

/** Stubs the Build Studio tree (one item-owned store, "item-widget") and the
 *  Supervisor's global state/app-candidate endpoints, with a stateful
 *  appCandidate that Activate/Promote/Discard actually flip — so the UI's
 *  own poll picks up the effect of what it just did, same as the real
 *  Supervisor would produce. */
async function stubBackend(page: Page): Promise<void> {
  let appCandidate: { branch: string; base: string } | null = null;

  await page.route("**/api/specs**", (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() !== "GET" || url.searchParams.has("path")) return route.continue();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(itemTree()) });
  });

  await page.route("**/__supervisor/state", (route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ base: null, previews: [], appCandidate }),
    });
  });

  await page.route("**/__supervisor/app-begin", (route) => {
    appCandidate = { branch: "app-candidate", base: "master" };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, ...appCandidate }) });
  });
  await page.route("**/__supervisor/app-promote", (route) => {
    appCandidate = null;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, promoted: true }) });
  });
  await page.route("**/__supervisor/app-discard", (route) => {
    appCandidate = null;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, discarded: true }) });
  });
}

async function openBuildStudio(page: Page) {
  await page.getByTestId("dock-build-studio").click();
  const win = page.getByTestId("window-build-studio");
  await expect(win).toBeVisible();
  // Waits for the item's own row, not its nested spec.md: the feature node
  // now starts collapsed, so the file inside it never renders without
  // expanding first — the row itself always renders regardless.
  await expect(win.getByTestId("build-studio-tree").locator('[data-node-type="feature"][data-key="item-widget"]')).toBeVisible({ timeout: 20000 });
  return win;
}

function itemRow(win: Locator) {
  return win.getByTestId("build-studio-tree").locator('[data-node-type="feature"][data-key="item-widget"]');
}

test.describe("Item-owned store activation — Build Studio", () => {
  test("right-clicking an item offers Activate; once active it offers Promote/Discard, and Discard returns it to inactive", async ({ page }) => {
    await stubBackend(page);
    const win = await openBuildStudio(page);
    const row = itemRow(win);
    await row.scrollIntoViewIfNeeded();
    await expect(row).toContainText("inactive");

    // --- Activate: one click, no branch-name prompt. ---
    await row.click({ button: "right" });
    await page.getByRole("button", { name: "Activate", exact: true }).click();

    await expect(row).toContainText("app-candidate", { timeout: 10000 });
    await expect(row).not.toContainText("inactive");

    // --- Right-click again: now offers Promote/Discard, not Activate. ---
    await row.click({ button: "right" });
    await expect(page.getByRole("button", { name: "Activate", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Promote", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Discard", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");

    // --- Discard (styled confirm dialog, since it loses uncommitted work). ---
    await row.click({ button: "right" });
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await page.getByRole("button", { name: "Discard", exact: true }).click(); // confirm dialog's own Discard button
    await expect(row).toContainText("inactive", { timeout: 10000 });
  });
});
