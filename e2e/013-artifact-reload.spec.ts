import { test, expect } from "./fixtures";

// Deterministic regression test for a real bug: re-opening an artifact that's
// already the active one (e.g. the agent edits a spec then calls
// buildstudio_artifact_open again to show the result) didn't refetch content,
// because activePath/activeBranch don't change value in that case — and
// clicking the tree "Refresh" button didn't help either, since it only
// reloaded the tree listing, not the open artifact. Drives the scripted e2e
// provider + direct /api/specs writes (simulating the agent's spec_edit) to
// reproduce both paths.

const script = (turns: unknown[]) => `@@e2e ${JSON.stringify({ turns })}`;

async function writeSpec(page: import("@playwright/test").Page, path: string, content: string) {
  const res = await page.request.put("/api/specs", { data: { path, content } });
  expect(res.ok()).toBeTruthy();
}

async function openBuildStudio(page: import("@playwright/test").Page) {
  await page.getByTestId("dock-build-studio").click();
  const win = page.getByTestId("window-build-studio");
  await expect(win).toBeVisible();
  await expect(win.getByTestId("chat-textarea")).toBeVisible({ timeout: 15000 });
  return win;
}

test.describe("Build Studio artifact reload", () => {
  test("re-opening an already-open artifact after an edit shows the new content", async ({ page }) => {
    const testPath = "user-specs/e2e-013-reopen-test/spec.md";
    await writeSpec(page, testPath, "# Reload Test\n\nOriginal content.\n");
    const win = await openBuildStudio(page);

    await win.getByTestId("chat-textarea").fill(
      script([{ text: "opening the test spec", tools: [{ name: "buildstudio_artifact_open", args: { path: testPath } }] }, { text: "Opened." }]),
    );
    await win.getByTestId("chat-send-button").click();
    await expect(win.getByText("Original content.")).toBeVisible({ timeout: 20000 });

    // Simulate the agent editing the spec out-of-band (spec_edit is a server
    // tool, not a surface tool — this PUT is the same underlying write path).
    await writeSpec(page, testPath, "# Reload Test\n\nUpdated content!\n");

    // Re-open the SAME path — before the fix, activePath didn't change value
    // so the content-fetch effect never re-ran, leaving the stale text shown.
    await win.getByTestId("chat-textarea").fill(
      script([{ text: "re-opening the test spec", tools: [{ name: "buildstudio_artifact_open", args: { path: testPath } }] }, { text: "Reopened." }]),
    );
    await win.getByTestId("chat-send-button").click();
    await expect(win.getByText("Updated content!")).toBeVisible({ timeout: 20000 });
    await expect(win.getByText("Original content.")).toHaveCount(0);
  });

  test("clicking the tree refresh button reloads the currently-open artifact too", async ({ page }) => {
    const testPath = "user-specs/e2e-013-refresh-test/spec.md";
    await writeSpec(page, testPath, "# Reload Test\n\nFirst version.\n");
    const win = await openBuildStudio(page);

    await win.getByTestId("chat-textarea").fill(
      script([{ text: "opening the test spec", tools: [{ name: "buildstudio_artifact_open", args: { path: testPath } }] }, { text: "Opened." }]),
    );
    await win.getByTestId("chat-send-button").click();
    await expect(win.getByText("First version.")).toBeVisible({ timeout: 20000 });

    await writeSpec(page, testPath, "# Reload Test\n\nSecond version.\n");

    // The manual refresh button (tree pane) should ALSO reload the open
    // artifact's content, not just the tree listing.
    await win.getByTitle("Refresh").click();
    await expect(win.getByText("Second version.")).toBeVisible({ timeout: 20000 });
  });
});
