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

// user-specs writes require a real feature branch (the same `bos/*` branch
// used for BOS's own source — there is no more per-Project activation call).
// No Supervisor runs in this e2e environment, so the branch doesn't actually
// mount a live worktree — the write still lands on the base checkout, same
// as it always has; the branch string here only needs to be non-empty to
// satisfy dev/spec-fs.ts's prepareWrite gate.
async function writeSpec(page: import("@playwright/test").Page, path: string, content: string) {
  const [, projectId] = path.split("/");
  const res = await page.request.put("/api/specs", { data: { path, content, branch: `${projectId}-work` } });
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
    // A little extra room beyond the default 30s: the recursive Project-layer
    // tree walk plus an extra activate-project round trip ahead of each write.
    test.setTimeout(60_000);
    const testPath = "user-specs/e2e-013-reopen-test/spec.md";
    await writeSpec(page, testPath, "# Reload Test\n\nOriginal content.\n");
    const win = await openBuildStudio(page);

    await win.getByTestId("chat-textarea").fill(
      script([{ text: "opening the test spec", tools: [{ name: "buildstudio_artifact_open", args: { path: testPath } }] }, { text: "Opened." }]),
    );
    await win.getByTestId("chat-send-button").click();
    await expect(win.getByText("Original content.")).toBeVisible({ timeout: 30000 });

    // Simulate the agent editing the spec out-of-band (spec_edit is a server
    // tool, not a surface tool — this PUT is the same underlying write path).
    await writeSpec(page, testPath, "# Reload Test\n\nUpdated content!\n");

    // Re-open the SAME path — before the fix, activePath didn't change value
    // so the content-fetch effect never re-ran, leaving the stale text shown.
    await win.getByTestId("chat-textarea").fill(
      script([{ text: "re-opening the test spec", tools: [{ name: "buildstudio_artifact_open", args: { path: testPath } }] }, { text: "Reopened." }]),
    );
    await win.getByTestId("chat-send-button").click();
    await expect(win.getByText("Updated content!")).toBeVisible({ timeout: 30000 });
    await expect(win.getByText("Original content.")).toHaveCount(0);
  });

  test("clicking the tree refresh button reloads the currently-open artifact too", async ({ page }) => {
    test.setTimeout(60_000);
    const testPath = "user-specs/e2e-013-refresh-test/spec.md";
    await writeSpec(page, testPath, "# Reload Test\n\nFirst version.\n");
    const win = await openBuildStudio(page);

    await win.getByTestId("chat-textarea").fill(
      script([{ text: "opening the test spec", tools: [{ name: "buildstudio_artifact_open", args: { path: testPath } }] }, { text: "Opened." }]),
    );
    await win.getByTestId("chat-send-button").click();
    await expect(win.getByText("First version.")).toBeVisible({ timeout: 30000 });

    await writeSpec(page, testPath, "# Reload Test\n\nSecond version.\n");

    // The manual refresh button (tree pane) should ALSO reload the open
    // artifact's content, not just the tree listing.
    await win.getByTitle("Refresh").click();
    await expect(win.getByText("Second version.")).toBeVisible({ timeout: 30000 });
  });
});
