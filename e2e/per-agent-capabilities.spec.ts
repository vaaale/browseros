import { test, expect } from "./fixtures";
import { resolveActionGate } from "../src/lib/agent/capabilities-registry";

// Deterministic smoke test for the per-agent capabilities UI (011/016). Opens
// Settings -> Assistant and asserts the unified capability editor renders. Never
// asserts on (nondeterministic) assistant output.
test.describe("Per-agent capabilities", () => {
  test("Settings -> Assistant shows the unified capability editor", async ({ page }) => {
    await page.getByTestId("dock-settings").click();
    const win = page.getByTestId("window-settings");
    await expect(win).toBeVisible();
    // The settings nav buttons are labeled by tab title; "Assistant" is the tab.
    await win.locator("nav").getByRole("button", { name: "Assistant", exact: true }).click();
    await expect(win.getByText("Save capabilities")).toBeVisible();
    // The unified catalog now lists main-chat actions too (016), not only sub-agent tools.
    await expect(win.getByText("launchApp", { exact: true })).toBeVisible();
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
