import { test, expect } from "./fixtures";

// Marketplace app master-detail UI (028): a sidebar listing every source
// ("All" + each registered marketplace + the user's own "My Apps"), which
// filters the main view, and collapsible per-source sections in that view.
//
// The catalog is stubbed so the test asserts UI behaviour rather than whatever
// marketplaces happen to be registered in the dev data directory.

const CATALOG = {
  marketplaces: [
    {
      id: "user-apps",
      url: "(local) dataDir()/user-apps/",
      name: "My Apps",
      lastSynced: null,
      items: [{ id: "my-widget", name: "My Widget", description: "a local thing", app: { version: "1.0.0" } }],
    },
    {
      id: "bos-marketplace",
      url: "https://example.test/bos-marketplace.git",
      name: "BrowserOS Marketplace",
      lastSynced: null,
      items: [
        { id: "welcome", name: "Welcome", description: "sample item", app: { version: "0.1.0" }, spec: { version: "0.1.0" } },
        { id: "pomodoro", name: "Pomodoro", description: "a focus timer", app: { version: "0.1.0" } },
      ],
    },
  ],
};

/** The master list. Scoped because a source's name appears twice on screen —
 *  once as a sidebar entry, once as its section header. */
function sidebar(page: import("@playwright/test").Page) {
  return page.locator("aside");
}

async function openMarketplace(page: import("@playwright/test").Page) {
  await page.route("/api/marketplace", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(CATALOG) });
  });

  await page.goto("/");
  const skip = page.getByRole("button", { name: "Skip" });
  if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {});

  // Open the Marketplace app from the desktop/dock.
  await page.getByText("Marketplace", { exact: true }).first().dblclick();
  await expect(sidebar(page).getByRole("button", { name: /^All/ })).toBeVisible({ timeout: 15_000 });
}

test.describe("Marketplace master-detail UI", () => {
  test("the sidebar lists All plus every source, with match counts", async ({ page }) => {
    await openMarketplace(page);

    const all = sidebar(page).getByRole("button", { name: /^All/ });
    await expect(all).toBeVisible();
    // 1 local item + 2 marketplace items.
    await expect(all).toContainText("3");

    await expect(sidebar(page).getByRole("button", { name: /My Apps/ })).toBeVisible();
    await expect(sidebar(page).getByRole("button", { name: /BrowserOS Marketplace/ })).toBeVisible();
  });

  test("selecting a source filters the main view; All clears the filter", async ({ page }) => {
    await openMarketplace(page);

    // Both sources' items are visible under "All".
    await expect(page.getByText("My Widget")).toBeVisible();
    await expect(page.getByText("Pomodoro")).toBeVisible();

    // Selecting My Apps hides the other source's items.
    await sidebar(page).getByRole("button", { name: /My Apps/ }).click();
    await expect(page.getByText("My Widget")).toBeVisible();
    await expect(page.getByText("Pomodoro")).toHaveCount(0);

    // Back to All restores them.
    await sidebar(page).getByRole("button", { name: /^All/ }).click();
    await expect(page.getByText("Pomodoro")).toBeVisible();
  });

  test("a source section collapses and expands from its header", async ({ page }) => {
    await openMarketplace(page);

    // The section header is the toggle; its items start visible.
    const header = page.getByRole("button", { expanded: true }).filter({ hasText: "BrowserOS Marketplace" });
    await expect(page.getByText("Pomodoro")).toBeVisible();

    await header.click();
    await expect(page.getByText("Pomodoro")).toHaveCount(0);
    // The header itself stays — only the item grid folds away.
    await expect(page.getByRole("button", { expanded: false }).filter({ hasText: "BrowserOS Marketplace" })).toBeVisible();

    await page.getByRole("button", { expanded: false }).filter({ hasText: "BrowserOS Marketplace" }).click();
    await expect(page.getByText("Pomodoro")).toBeVisible();
  });

  test("the text filter and the source filter compose", async ({ page }) => {
    await openMarketplace(page);

    await page.getByPlaceholder("Filter items…").fill("pomo");
    await expect(page.getByText("Pomodoro")).toBeVisible();
    await expect(page.getByText("My Widget")).toHaveCount(0);
    // The sidebar count follows the text filter, so it can never disagree with
    // what the main view shows.
    await expect(sidebar(page).getByRole("button", { name: /^All/ })).toContainText("1");
  });
});
