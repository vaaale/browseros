import { test, expect } from "./fixtures";
import { resolveActionGate } from "../src/lib/agent/capabilities-registry";

// Deterministic smoke test for the unified capability catalog UI (011/016).
// Opens Settings -> Tools and asserts the catalog renders. Never asserts on
// (nondeterministic) assistant output.
test.describe("Per-agent capabilities", () => {
  test("Settings -> Tools shows the unified capability catalog", async ({ page }) => {
    await page.getByTestId("dock-settings").click();
    const win = page.getByTestId("window-settings");
    await expect(win).toBeVisible();
    // The capability catalog lives on the "Tools" tab (nav buttons are labeled by
    // tab title). Saving is automatic — there is no explicit save button.
    await win.locator("nav").getByRole("button", { name: "Tools", exact: true }).click();
    // The unified catalog lists every capability id (grouped by category),
    // main-chat actions included — e.g. bos_app_launch under the "OS" group.
    await expect(win.getByText("bos_app_launch", { exact: true })).toBeVisible();
  });
});

// The per-agent action gate rule (016 + Phase B strict allowlist). null =
// loading (allow everything); [] = explicit zero (deny everything); non-empty
// list = strict allowlist.
test.describe("Unified agents — action gate", () => {
  test("null allowlist means loading and allows everything", () => {
    expect(resolveActionGate(undefined)("launchApp")).toBe(true);
    expect(resolveActionGate(null)("launchApp")).toBe(true);
  });
  test("empty allowlist strictly disallows every action", () => {
    const gate = resolveActionGate([]);
    expect(gate("launchApp")).toBe(false);
    expect(gate("listSpecs")).toBe(false);
  });
  test("a strict allowlist gates to exactly the listed ids", () => {
    const gate = resolveActionGate(["listSpecs", "openSpecArtifact", "read_spec"]);
    expect(gate("listSpecs")).toBe(true);
    expect(gate("openSpecArtifact")).toBe(true);
    expect(gate("launchApp")).toBe(false);
    expect(gate("runWorkflow")).toBe(false);
  });
});
