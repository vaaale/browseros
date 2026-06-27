import { test, expect } from "./fixtures";

// Baseline OS golden-path suite. Deterministic only — these exercise the shell
// and built-in apps and never assert on (nondeterministic) assistant/LLM output.
test.describe("BrowserOS desktop", () => {
  test("renders the desktop shell and dock", async ({ page }) => {
    await expect(page.getByTestId("desktop")).toBeVisible();
    await expect(page.getByTestId("dock")).toBeVisible();
  });

  test("opens the Settings app from the dock", async ({ page }) => {
    await page.getByTestId("dock-settings").click();
    await expect(page.getByTestId("window-settings")).toBeVisible();
  });

  test("opens and closes the Files app", async ({ page }) => {
    await page.getByTestId("dock-files").click();
    const win = page.getByTestId("window-files");
    await expect(win).toBeVisible();
    await win.getByRole("button", { name: "Close" }).click();
    await expect(win).toBeHidden();
  });

  test("opens the Assistant window (no assertion on model output)", async ({ page }) => {
    await page.getByTestId("dock-chat").click();
    await expect(page.getByTestId("window-chat")).toBeVisible();
  });
});
