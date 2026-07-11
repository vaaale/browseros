import { test, expect } from "./fixtures";

// Deterministic smoke test for the UI Preview app (013-build-studio-agentic V2).
// Drives the scripted e2e provider (src/lib/assistant/e2e-provider.ts) to call
// the real ui_preview_open Tier 1 tool, then asserts the A2UI surface host
// window mounts. Never asserts on (nondeterministic) LLM-generated A2UI output.

const script = (turns: unknown[]) => `@@e2e ${JSON.stringify({ turns })}`;

test.describe("UI Preview", () => {
  test("ui_preview_open mounts the A2UI surface container", async ({ page }) => {
    await page.getByText("Assistant", { exact: true }).first().dblclick({ timeout: 20000 });
    await expect(page.getByTestId("assistant-v2")).toBeVisible({ timeout: 20000 });
    const textarea = page.getByTestId("chat-textarea");
    await expect(textarea).toBeVisible({ timeout: 15000 });

    await textarea.fill(script([{ text: "opening UI Preview", tools: [{ name: "ui_preview_open", args: {} }] }, { text: "Opened it." }]));
    await page.getByTestId("chat-send-button").click();

    const win = page.getByTestId("window-ui-preview");
    await expect(win).toBeVisible({ timeout: 20000 });
    await expect(win.getByText(/Waiting for the agent to render a design/i)).toBeVisible({ timeout: 10000 });
  });
});
