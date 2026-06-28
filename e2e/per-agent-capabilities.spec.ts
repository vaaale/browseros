import { test, expect } from "./fixtures";

// Deterministic smoke test for the per-agent capabilities UI (011). Opens
// Settings -> Assistant and asserts the capability editor renders. Never asserts
// on (nondeterministic) assistant output.
test.describe("Per-agent capabilities", () => {
  test("Settings -> Assistant shows the capability editor", async ({ page }) => {
    await page.getByTestId("dock-settings").click();
    const win = page.getByTestId("window-settings");
    await expect(win).toBeVisible();
    // The settings nav buttons are labeled by tab title; "Assistant" is the tab.
    await win.locator("nav").getByRole("button", { name: "Assistant", exact: true }).click();
    await expect(win.getByText(/Capabilities/)).toBeVisible();
    await expect(win.getByText("Save capabilities")).toBeVisible();
  });
});
