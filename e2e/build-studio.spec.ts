import { test, expect } from "./fixtures";

// Deterministic smoke test for the Build Studio app. Asserts the window opens and
// the spec tree renders the in-repo 001-build-studio feature. Never asserts on
// (nondeterministic) assistant/LLM output.
test.describe("Build Studio", () => {
  test("opens from the dock and shows the spec tree", async ({ page }) => {
    await page.getByTestId("dock-build-studio").click();
    const win = page.getByTestId("window-build-studio");
    await expect(win).toBeVisible();
    // The seeded specs/001-build-studio feature is listed; its artifacts render
    // because feature nodes start expanded.
    await expect(win.getByText("spec.md")).toBeVisible();
  });
});
