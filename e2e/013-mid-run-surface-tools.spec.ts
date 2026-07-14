import { test, expect, type Page } from "./fixtures";

// Regression test for a real bug: surfaceTools was only ever read once, when a
// run STARTS, so a Tier 2 tool contributed by a window opened DURING that
// same run (e.g. the agent calls ui_preview_open, then in the next step wants
// ui_preview_generate) was never available — the model would say things like
// "I don't have access to ui_preview_generate" and the run would finish with no
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
  test("ui_preview_generate is callable in the SAME run that just opened UI Preview", async ({ page }) => {
    const win = await openBuildStudio(page);

    // One run, two steps: step 1 opens UI Preview (a window that wasn't open
    // when this run started); step 2 immediately tries to render on it. Before
    // the fix, ui_preview_generate would be "unknown tool" here. Uses the
    // `@@e2e` deterministic bypass so no live LLM call is needed.
    const ops = [{ version: "v0.9", createSurface: { surfaceId: "test-surface" } }];
    await win.getByTestId("chat-textarea").fill(
      script([
        { text: "opening UI Preview", tools: [{ name: "ui_preview_open", args: {} }] },
        {
          text: "rendering the mockup",
          tools: [{ name: "ui_preview_generate", args: { description: `@@e2e ${JSON.stringify({ operations: ops })}` } }],
        },
        { text: "Done." },
      ]),
    );
    await win.getByTestId("chat-send-button").click();
    await expect(win.getByTestId("assistant-message").last()).toContainText("Done.", { timeout: 30000 });

    const results = await toolResults(page);
    expect(results.some((r) => /Generated and rendered a new mockup/.test(r))).toBe(true);
    expect(results.some((r) => /unknown tool|no client executed/i.test(r))).toBe(false);
  });
});
