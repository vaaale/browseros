import { test, expect } from "./fixtures";

// Deterministic smoke test for the Build Studio app. Asserts the window opens and
// the spec tree renders the in-repo 001-build-studio feature. Never asserts on
// (nondeterministic) assistant/LLM output.
test.describe("Build Studio", () => {
  test("opens from the dock and shows the spec tree", async ({ page }) => {
    await page.getByTestId("dock-build-studio").click();
    const win = page.getByTestId("window-build-studio");
    await expect(win).toBeVisible();
    // Feature nodes start expanded, so each migrated feature's spec.md renders;
    // assert at least one is visible (the tree mirrors specs/).
    await expect(win.getByText("spec.md").first()).toBeVisible();
    // The embedded assistant chat (pinned to the Build Studio agent) mounted.
    await expect(win.getByRole("textbox").first()).toBeVisible();
  });
});
