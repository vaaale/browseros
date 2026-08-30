import { test, expect, type Page } from "./fixtures";

// Deterministic smoke test for buildstudio_artifact_highlight (013-build-studio-agentic
// V2). Drives the scripted e2e provider to open an in-repo spec, then highlight a real
// heading, asserting: the viewer centers on it, the WHOLE section is highlighted (the
// heading plus its nested subsection, not just the heading line), the highlight has no
// timeout, and clicking anywhere in it clears it. Also asserts the two error paths
// (unknown anchor; no artifact open). Never asserts on (nondeterministic) LLM content.

const script = (turns: unknown[]) => `@@e2e ${JSON.stringify({ turns })}`;
const HIGHLIGHT_CLASS = ".bg-amber-400\\/15"; // matches HIGHLIGHT_CLASSES in build-studio/index.tsx

// Bundled fixture — written by each test into the writable user-specs store
// rather than depending on any pre-existing (live) spec content. Structure
// mirrors a real feature spec closely enough to exercise the "whole section"
// highlight: a nested "### Session 2026-06-28" subsection immediately follows
// "## Clarifications", bounded by a following "## Requirements" heading.
const SPEC_PATH = "user-specs/e2e-013-spec-anchor-test/spec.md";
const SPEC_CONTENT = [
  "# 013 Build Studio Agentic V2 (test fixture)",
  "",
  "Intro paragraph for the test fixture.",
  "",
  "## Overview",
  "",
  "Some overview text.",
  "",
  "## Clarifications",
  "",
  "Clarifying notes for this test fixture.",
  "",
  "### Session 2026-06-28",
  "",
  "- Q: What happens when the artifact isn't open?",
  "- A: The tool returns a clear error.",
  "",
  "## Requirements",
  "",
  "Requirement body text.",
  "",
].join("\n");

// user-specs writes require a real feature branch (the same `bos/*` branch
// used for BOS's own source — there is no more per-Project activation call).
// No Supervisor runs in this e2e environment, so the branch doesn't actually
// mount a live worktree — the write still lands on the base checkout, same
// as it always has; the branch string here only needs to be non-empty to
// satisfy dev/spec-fs.ts's prepareWrite gate.
async function writeSpec(page: Page, path: string, content: string): Promise<void> {
  const [, projectId] = path.split("/");
  const res = await page.request.put("/api/specs", { data: { path, content, branch: `${projectId}-work` } });
  expect(res.ok()).toBeTruthy();
}

async function openBuildStudio(page: Page) {
  await page.getByTestId("dock-build-studio").click();
  const win = page.getByTestId("window-build-studio");
  await expect(win).toBeVisible();
  await expect(win.getByTestId("chat-textarea")).toBeVisible({ timeout: 15000 });
  return win;
}

// Searches ALL tool-result messages for one containing `expected`, rather
// than assuming the LAST tool message is the one under test — the assistant's
// own instructions can trigger an unrelated automatic memory_recall tool call
// around a scripted turn, which would otherwise land after the tool call this
// test actually cares about and make a plain "last message" lookup flaky.
async function hasToolResultContaining(page: Page, expected: string): Promise<boolean> {
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("bos.activeConversation.build-studio") ?? ""), { timeout: 10000 })
    .not.toBe("");
  const convId = await page.evaluate(() => localStorage.getItem("bos.activeConversation.build-studio") ?? "");
  // The tool-result message can land in the conversation's persisted history
  // slightly after its text is already visible in the UI — poll rather than
  // fetching once, to avoid a race with that persistence lag.
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const { messages } = await page.request.get(`/api/assistant/conversations/${convId}/messages`).then((r) => r.json());
    const toolMessages = messages.filter((m: { role: string }) => m.role === "tool");
    if (toolMessages.some((m: { content?: string }) => (m.content ?? "").includes(expected))) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

test.describe("Build Studio spec anchors", () => {
  test("buildstudio_artifact_highlight centers and highlights the whole section; clicking it clears the highlight", async ({ page }) => {
    // A little extra room beyond the default 30s: the recursive Project-layer
    // tree walk plus an extra activate-project round trip ahead of each write.
    test.setTimeout(60_000);
    await writeSpec(page, SPEC_PATH, SPEC_CONTENT);
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
    await expect(heading).toBeVisible({ timeout: 30000 });
    // Both tool calls (open, then highlight) need to complete — give this
    // more room than the default 5s.
    await expect(heading).toHaveClass(/bg-amber-400\/15/, { timeout: 30000 });
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
    test.setTimeout(60_000);
    await writeSpec(page, SPEC_PATH, SPEC_CONTENT);
    const win = await openBuildStudio(page);

    // No artifact open yet in this fresh conversation. Wait for the scripted
    // run's final text (not stop-button absence, which can false-positive
    // before a near-instant run has even started) to know it's done.
    await win.getByTestId("chat-textarea").fill(
      script([{ text: "highlighting with nothing open", tools: [{ name: "buildstudio_artifact_highlight", args: { anchor: "clarifications" } }] }, { text: "Done1." }]),
    );
    await win.getByTestId("chat-send-button").click();
    await expect(win.getByText("Done1.")).toBeVisible({ timeout: 30000 });
    expect(await hasToolResultContaining(page, "No artifact is open")).toBeTruthy();

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
    await expect(win.getByText("Done2.")).toBeVisible({ timeout: 30000 });
    expect(await hasToolResultContaining(page, 'No section with anchor "does-not-exist"')).toBeTruthy();
  });

  test("a heading-looking line inside a fenced code block is not treated as a real anchor", async ({ page }) => {
    test.setTimeout(60_000);
    // Regression: extractHeadingAnchors used to scan every "#..." line for a
    // heading, including ones inside ``` fences (not real headings, and with
    // no corresponding rendered element) — which used to make the tool
    // report success while nothing was actually found/highlighted, since the
    // DOM lookup happened later and separately from the text-based check.
    // Now the whole thing happens in one step, so a false-positive text match
    // can no longer produce a false "success".
    const testPath = "user-specs/e2e-013-fenced-heading-test/spec.md";
    const content = "# Real Doc\n\n```\n# Not A Real Heading\n```\n\nSome body text.\n";
    await writeSpec(page, testPath, content);

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
    await expect(win.getByText("Done3.")).toBeVisible({ timeout: 30000 });
    expect(await hasToolResultContaining(page, 'No section with anchor "not-a-real-heading"')).toBeTruthy();
  });
});
