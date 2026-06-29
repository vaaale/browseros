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

// The per-agent action gate rule (016), framework-free + back-compatible.
test.describe("Unified agents — action gate", () => {
  test("unset/empty allowlist allows all actions", () => {
    expect(resolveActionGate(undefined)("launchApp")).toBe(true);
    expect(resolveActionGate([])("launchApp")).toBe(true);
  });
  test("legacy allowlist of only server tool ids leaves actions open (back-compat)", () => {
    const gate = resolveActionGate(["read_spec", "write_spec", "delegate_to_developer"]);
    expect(gate("launchApp")).toBe(true);
    expect(gate("listSpecs")).toBe(true);
  });
  test("an allowlist that names actions gates to exactly those", () => {
    const gate = resolveActionGate(["listSpecs", "openSpecArtifact", "read_spec"]);
    expect(gate("listSpecs")).toBe(true);
    expect(gate("openSpecArtifact")).toBe(true);
    expect(gate("launchApp")).toBe(false);
    expect(gate("runWorkflow")).toBe(false);
  });
});
