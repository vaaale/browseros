import { test, expect, type Page } from "./fixtures";

// Regression test for a real bug: surfaceTools was only ever read once, when a
// run STARTS, so a Tier 2 tool contributed by a window opened DURING that
// same run (e.g. the agent calls ui_preview_open, then in the next step wants
// ui_preview_render) was never available — the model would say things like
// "I don't have access to ui_preview_render" and the run would finish with no
// content ever pushed to the UI Preview surface, even though the window was
// genuinely open by then. Fixed by pushing the surface-tools registry's
// current declarations to any attached run whenever it changes, merged live
// into that run's tool set.

const script = (turns: unknown[]) => `@@e2e ${JSON.stringify({ turns })}`;

async function openBuildStudio(page: Page) {
  await page.getByTestId("dock-build-studio").click();
  const win = page.getByTestId("window-build-studio");
  await expect(win).toBeVisible();
  await expect(win.getByTestId("chat-textarea")).toBeVisible({ timeout: 15000 });
  return win;
}

async function toolResults(page: Page): Promise<string[]> {
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("bos.activeConversation.build-studio") ?? ""), { timeout: 10000 })
    .not.toBe("");
  const convId = await page.evaluate(() => localStorage.getItem("bos.activeConversation.build-studio") ?? "");
  const { messages } = await page.request.get(`/api/assistant/conversations/${convId}/messages`).then((r) => r.json());
  return messages.filter((m: { role: string }) => m.role === "tool").map((m: { content: string }) => m.content);
}

test.describe("Surface tools become available mid-run", () => {
  test("ui_preview_render is callable in the SAME run that just opened UI Preview", async ({ page }) => {
    const win = await openBuildStudio(page);

    // One run, two steps: step 1 opens UI Preview (a window that wasn't open
    // when this run started); step 2 immediately tries to push operations to
    // it. Before the fix, ui_preview_render would be "unknown tool" here.
    await win.getByTestId("chat-textarea").fill(
      script([
        { text: "opening UI Preview", tools: [{ name: "ui_preview_open", args: {} }] },
        {
          text: "rendering the mockup",
          tools: [{ name: "ui_preview_render", args: { surfaceId: "test-surface", operations: [{ version: "v0.9", createSurface: { surfaceId: "test-surface" } }] } }],
        },
        { text: "Done." },
      ]),
    );
    await win.getByTestId("chat-send-button").click();
    await expect(win.getByTestId("assistant-message").last()).toContainText("Done.", { timeout: 30000 });

    const results = await toolResults(page);
    expect(results).toContain('Rendered 1 operation(s) on surface "test-surface".');
    expect(results.some((r) => /unknown tool|no client executed/i.test(r))).toBe(false);
  });
});
