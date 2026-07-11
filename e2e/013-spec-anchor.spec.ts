import { test, expect, type Page } from "./fixtures";

// Deterministic smoke test for buildstudio_artifact_highlight (013-build-studio-agentic
// V2). Drives the scripted e2e provider to open an in-repo spec, then highlight a real
// heading, asserting: the viewer centers on it, the WHOLE section is highlighted (the
// heading plus its nested subsection, not just the heading line), the highlight has no
// timeout, and clicking anywhere in it clears it. Also asserts the two error paths
// (unknown anchor; no artifact open). Never asserts on (nondeterministic) LLM content.

const script = (turns: unknown[]) => `@@e2e ${JSON.stringify({ turns })}`;
const SPEC_PATH = "bos-system-specs/001-build-studio/spec.md";
const HIGHLIGHT_CLASS = ".bg-amber-400\\/15"; // matches HIGHLIGHT_CLASSES in build-studio/index.tsx

async function openBuildStudio(page: Page) {
  await page.getByTestId("dock-build-studio").click();
  const win = page.getByTestId("window-build-studio");
  await expect(win).toBeVisible();
  await expect(win.getByTestId("chat-textarea")).toBeVisible({ timeout: 15000 });
  return win;
}

async function lastToolResult(page: Page): Promise<string> {
  // The conversation is created client-side and may not have landed in
  // localStorage the instant the run finishes — poll briefly rather than
  // reading it once.
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("bos.activeConversation.build-studio") ?? ""), { timeout: 10000 })
    .not.toBe("");
  const convId = await page.evaluate(() => localStorage.getItem("bos.activeConversation.build-studio") ?? "");
  const { messages } = await page.request.get(`/api/assistant/conversations/${convId}/messages`).then((r) => r.json());
  const toolMessages = messages.filter((m: { role: string }) => m.role === "tool");
  return toolMessages[toolMessages.length - 1]?.content ?? "";
}

test.describe("Build Studio spec anchors", () => {
  test("buildstudio_artifact_highlight centers and highlights the whole section; clicking it clears the highlight", async ({ page }) => {
    const win = await openBuildStudio(page);

    await win.getByTestId("chat-textarea").fill(
      script([
        {
          text: "opening the spec and highlighting a section",
          tools: [
            { name: "buildstudio_artifact_open", args: { path: SPEC_PATH } },
            { name: "buildstudio_artifact_highlight", args: { anchor: "clarifications" } },
          ],
        },
        { text: "Done." },
      ]),
    );
    await win.getByTestId("chat-send-button").click();

    const heading = win.locator("#clarifications");
    await expect(heading).toBeVisible({ timeout: 20000 });
    // Both tool calls (open, then highlight) need to complete — give this
    // more room than the default 5s.
    await expect(heading).toHaveClass(/bg-amber-400\/15/, { timeout: 20000 });
    // The whole section is highlighted, including a nested subheading (### Session
    // 2026-06-28 immediately follows ## Clarifications in this spec) — not just the
    // heading line.
    await expect(win.locator("#session-2026-06-28")).toHaveClass(/bg-amber-400\/15/);
    expect(await win.locator(HIGHLIGHT_CLASS).count()).toBeGreaterThan(1);

    // No timeout — the highlight is still there after a few seconds.
    await page.waitForTimeout(2000);
    await expect(heading).toHaveClass(/bg-amber-400\/15/);

    // Clicking anywhere inside the highlighted section clears it.
    await heading.click();
    await expect(win.locator(HIGHLIGHT_CLASS)).toHaveCount(0);
  });

  test("buildstudio_artifact_highlight errors on an unknown anchor or no open artifact", async ({ page }) => {
    const win = await openBuildStudio(page);

    // No artifact open yet in this fresh conversation. Wait for the scripted
    // run's final text (not stop-button absence, which can false-positive
    // before a near-instant run has even started) to know it's done.
    await win.getByTestId("chat-textarea").fill(
      script([{ text: "highlighting with nothing open", tools: [{ name: "buildstudio_artifact_highlight", args: { anchor: "clarifications" } }] }, { text: "Done1." }]),
    );
    await win.getByTestId("chat-send-button").click();
    await expect(win.getByTestId("assistant-message").last()).toContainText("Done1.", { timeout: 30000 });
    expect(await lastToolResult(page)).toContain("No artifact is open");

    // Now open the spec, then ask for a heading that doesn't exist.
    await win.getByTestId("chat-textarea").fill(
      script([
        {
          text: "opening then highlighting a bogus anchor",
          tools: [
            { name: "buildstudio_artifact_open", args: { path: SPEC_PATH } },
            { name: "buildstudio_artifact_highlight", args: { anchor: "does-not-exist" } },
          ],
        },
        { text: "Done2." },
      ]),
    );
    await win.getByTestId("chat-send-button").click();
    await expect(win.getByTestId("assistant-message").last()).toContainText("Done2.", { timeout: 30000 });
    expect(await lastToolResult(page)).toContain('No section with anchor "does-not-exist"');
  });

  test("a heading-looking line inside a fenced code block is not treated as a real anchor", async ({ page }) => {
    // Regression: extractHeadingAnchors used to scan every "#..." line for a
    // heading, including ones inside ``` fences (not real headings, and with
    // no corresponding rendered element) — which used to make the tool
    // report success while nothing was actually found/highlighted, since the
    // DOM lookup happened later and separately from the text-based check.
    // Now the whole thing happens in one step, so a false-positive text match
    // can no longer produce a false "success".
    const testPath = "user-specs/e2e-013-fenced-heading-test/spec.md";
    const content = "# Real Doc\n\n```\n# Not A Real Heading\n```\n\nSome body text.\n";
    const res = await page.request.put("/api/specs", { data: { path: testPath, content } });
    expect(res.ok()).toBeTruthy();

    const win = await openBuildStudio(page);
    await win.getByTestId("chat-textarea").fill(
      script([
        {
          text: "opening then highlighting the fenced-in fake heading",
          tools: [
            { name: "buildstudio_artifact_open", args: { path: testPath } },
            { name: "buildstudio_artifact_highlight", args: { anchor: "not-a-real-heading" } },
          ],
        },
        { text: "Done3." },
      ]),
    );
    await win.getByTestId("chat-send-button").click();
    await expect(win.getByTestId("assistant-message").last()).toContainText("Done3.", { timeout: 30000 });
    expect(await lastToolResult(page)).toContain('No section with anchor "not-a-real-heading"');
  });
});
