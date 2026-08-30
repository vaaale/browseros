import { test, expect, type Page, type Locator } from "./fixtures";

// End-to-end coverage for the store-level (not per-Project) git workflow in
// Build Studio: user-specs becomes editable once a real `bos/*` feature
// branch is selected via this window's OWN embedded chat conversation (the
// same "Active feature branch" dropdown the assistant chat already has —
// no separate Build Studio picker, no per-Project Activate button). This
// replaced the earlier per-Project lightweight git-worktree flow
// (037-project-layer's `project-git.ts`, retired) once it became clear BOS
// should reuse the pre-existing bos/* branch mechanism instead of inventing
// a new one.
//
// Selecting an EXISTING branch from that dropdown only writes to the
// conversation's own state file (`setConversationActiveFeatureBranch`) — it
// never touches git. Choosing "New feature branch..." would instead perform
// a REAL `git checkout -b` on the live BOS source repo this dev server runs
// from (src/lib/system/git.ts's `createFeatureBranch`, standalone-dev-mode
// only) — never trigger that from a test. Instead, `GET
// /api/assistant/feature-branches` (which populates the dropdown's options)
// is stubbed to offer one fake branch name, so this test only ever selects
// an already-"existing" one.

async function openBuildStudio(page: Page) {
  await page.getByTestId("dock-build-studio").click();
  const win = page.getByTestId("window-build-studio");
  await expect(win).toBeVisible();
  // The tree's initial /api/specs fetch can take a while on a dev server's
  // first (cold, un-compiled) hit — wait generously for real content rather
  // than the default 5s, instead of racing the "No specs yet" empty state.
  // Waits for a PROJECT ROW, not a file: every container now starts
  // collapsed at every depth, so a file several levels down (project ->
  // feature -> file) never renders without expanding first — a project's own
  // row, in contrast, always renders as soon as the tree loads.
  await expect(win.getByTestId("build-studio-tree").locator('[data-node-type="project"]').first()).toBeVisible({ timeout: 20000 });
  return win;
}

/** Stubs the dropdown's branch LIST only — never the branch-creation POST,
 *  which would perform a real git checkout on this dev server's own repo. */
async function stubFeatureBranchList(page: Page, branch: string): Promise<void> {
  await page.route("**/api/assistant/feature-branches", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ featureBranches: [branch] }) });
  });
}

function userSpecsBadge(win: Locator): Locator {
  return win.getByTestId("user-specs-branch-badge");
}

function userProjectFile(win: Locator, name: string): Locator {
  return win.getByTestId("build-studio-tree").locator(`[data-node-type="file"][data-key^="user-specs/"]`, { hasText: name }).first();
}

async function rightClick(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  await locator.click({ button: "right" });
}

test.describe("user-specs branch-coupled editing — Build Studio", () => {
  test("selecting a feature branch makes user-specs editable; edit -> history -> rename -> delete; deselecting makes it read-only again", async ({ page }) => {
    test.setTimeout(120_000);
    const branch = "bos/e2e-user-specs-work";
    await stubFeatureBranchList(page, branch);
    const win = await openBuildStudio(page);

    const badge = userSpecsBadge(win);
    await badge.scrollIntoViewIfNeeded();
    // Self-healing: a previous failed run of this same test (or a manual
    // check against this dev server) may have left this window's real,
    // persisted conversation state pointed at a stale branch — this
    // conversation's `activeFeatureBranch` isn't test-isolated data.
    const selector = win.getByLabel("Active feature branch");
    await expect(selector).toBeVisible({ timeout: 10000 });
    if ((await badge.textContent()) !== "no branch selected") {
      await selector.selectOption("");
      await expect(badge).toHaveText("no branch selected", { timeout: 10000 });
    }

    // --- Select the branch in this window's own embedded chat ---
    await selector.selectOption(branch);
    await expect(badge).toHaveText(branch, { timeout: 10000 });

    // --- Bundle a fixture on that branch, then refresh to pick it up ---
    const writeRes = await page.request.put("/api/specs", {
      data: { path: "user-specs/user/e2e-037-project-layer-test/spec.md", content: "# E2E fixture\n\nOriginal content.\n", branch },
    });
    expect(writeRes.ok()).toBeTruthy();
    await win.getByTitle("Refresh").click();

    // The "user" Project itself starts collapsed (no more per-Project
    // Activate step to auto-expand it) — expand it to reach the fixture.
    // Every level is now independently collapsed, so the feature leaf
    // revealed by that click needs its own expand too before its file shows.
    const userProject = win.getByTestId("build-studio-tree").locator('[data-node-type="project"][data-key="user-specs/user"]');
    await userProject.scrollIntoViewIfNeeded();
    await userProject.click();
    const fixtureFeature = win.getByTestId("build-studio-tree").locator('[data-node-type="feature"][data-key="user-specs/user/e2e-037-project-layer-test"]');
    await fixtureFeature.scrollIntoViewIfNeeded();
    await fixtureFeature.click();

    // --- Open the fixture file, edit and save ---
    const specFile = userProjectFile(win, "spec.md");
    await specFile.scrollIntoViewIfNeeded();
    await specFile.click();
    await win.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = win.getByTestId("build-studio-editor");
    await expect(editor).toBeVisible();
    const original = await editor.inputValue();
    await editor.fill(original + "\n\ne2e appended line.\n");
    await win.getByRole("button", { name: "Save", exact: true }).click();
    await expect(win.getByText("e2e appended line.")).toBeVisible({ timeout: 10000 });

    // --- View history: at least the edit above shows up ---
    await rightClick(specFile);
    await page.getByRole("button", { name: "View history", exact: true }).click();
    await expect(page.getByText(/^History —/)).toBeVisible();
    await expect(page.getByText(/spec: (write|edit) .*spec\.md/).first()).toBeVisible({ timeout: 10000 });
    await page.getByTestId("history-dialog-close").click();

    // --- Deselect the branch: this SAME file becomes read-only (Rename/
    // Delete disabled); View history stays available either way. ---
    await selector.selectOption("");
    await expect(badge).toHaveText("no branch selected", { timeout: 10000 });
    await rightClick(specFile);
    await expect(page.getByRole("button", { name: "View history", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Rename", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");

    // --- Re-select the branch to finish the lifecycle: rename, then delete ---
    await selector.selectOption(branch);
    await expect(badge).toHaveText(branch, { timeout: 10000 });

    // --- Rename that same file ---
    await rightClick(specFile);
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    const renameInput = page.getByTestId("prompt-dialog-input");
    await renameInput.fill("spec-renamed.md");
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    const renamedFile = userProjectFile(win, "spec-renamed.md");
    await expect(renamedFile).toBeVisible({ timeout: 10000 });

    // --- Delete the renamed file ---
    await rightClick(renamedFile);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click(); // confirm dialog's own Delete button
    await expect(renamedFile).toHaveCount(0, { timeout: 30000 });

    // --- Leave the window's conversation branch cleared, same as it started ---
    await selector.selectOption("");
    await expect(badge).toHaveText("no branch selected", { timeout: 10000 });
  });

  test("bos-system-specs is fully read-only: right-clicking a Project or a file inside it does nothing", async ({ page }) => {
    const win = await openBuildStudio(page);
    const tree = win.getByTestId("build-studio-tree");

    // bos-system-specs/core-platform has guaranteed-persistent content
    // (000-browseros-core) and is never writable, branch or not.
    const coreProject = tree.locator('[data-node-type="project"][data-key="bos-system-specs/core-platform"]');
    await coreProject.scrollIntoViewIfNeeded();
    await coreProject.click({ button: "right" });
    // No context menu portal renders at all — not even a disabled one.
    await expect(page.getByRole("button", { name: "Activate", exact: true })).toHaveCount(0);

    await coreProject.click(); // expand the project — collapsed by default
    const coreFeature = tree.locator('[data-node-type="feature"][data-key="bos-system-specs/core-platform/000-browseros-core"]');
    await coreFeature.click(); // expand the feature leaf to reveal its files
    const specFile = tree.locator('[data-node-type="file"][data-key^="bos-system-specs/core-platform/"]', { hasText: "spec.md" }).first();
    await rightClick(specFile);
    await expect(page.getByRole("button", { name: "View history", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Rename", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
  });

  test("projects start collapsed on open", async ({ page }) => {
    const win = await openBuildStudio(page);
    const tree = win.getByTestId("build-studio-tree");

    // A Project (bos-system-specs/core-platform, never touched by any other
    // test in this file) starts collapsed — its children aren't even in the DOM.
    const coreProject = tree.locator('[data-node-type="project"][data-key="bos-system-specs/core-platform"]');
    await coreProject.scrollIntoViewIfNeeded();
    const coreChild = tree.locator('[data-key="bos-system-specs/core-platform/000-browseros-core"]');
    await expect(coreChild).toHaveCount(0);

    // Clicking it expands it, same as any other container.
    await coreProject.click();
    await expect(coreChild).toBeVisible();

    // A manual refresh doesn't re-collapse what the user just expanded by hand.
    await win.getByTitle("Refresh").click();
    await page.waitForTimeout(1000);
    await expect(coreChild).toBeVisible();
  });
});
