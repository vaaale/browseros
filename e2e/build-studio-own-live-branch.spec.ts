import { test, expect, type Page } from "./fixtures";

// Regression test for a real production report: content the agent wrote via
// file_write on an active `bos/*` feature branch only shows up in Build
// Studio's tree via the pre-existing 020 draft-branch grafting (it hasn't
// been promoted to user-specs' base checkout yet) — and that grafting has
// ALWAYS treated any branch-only content as a foreign, read-only preview.
// But once that SAME branch is the user's own live editing branch (selected
// in this window's embedded chat), it isn't foreign at all — it's exactly
// the file the user is trying to keep working on, and Build Studio must
// open it live/editable instead of as a read-only "draft on <branch>"
// preview. A genuinely different (not-selected) branch's draft content must
// still be treated as a real read-only preview.
//
// /api/specs and /api/assistant/feature-branches are stubbed so this doesn't
// depend on any real Supervisor-provisioned worktree or draft branch
// existing on the dev server this runs against.

const OWN_BRANCH = "bos/testfixture-e2e-own-work";
const FOREIGN_BRANCH = "bos/testfixture-e2e-someone-branch";

function tree() {
  return {
    tree: [
      {
        type: "group",
        name: "user-specs",
        label: "User specs",
        path: "user-specs",
        owner: "user",
        writable: true,
        children: [
          {
            type: "feature",
            name: "001-live-draft",
            path: "user-specs/proj/001-live-draft",
            branch: OWN_BRANCH,
            children: [{ type: "file", name: "spec.md", path: "user-specs/proj/001-live-draft/spec.md", branch: OWN_BRANCH }],
          },
          {
            type: "feature",
            name: "002-foreign-draft",
            path: "user-specs/proj/002-foreign-draft",
            branch: FOREIGN_BRANCH,
            children: [{ type: "file", name: "spec.md", path: "user-specs/proj/002-foreign-draft/spec.md", branch: FOREIGN_BRANCH }],
          },
        ],
      },
    ],
    specs: [],
  };
}

async function stubBackend(page: Page): Promise<void> {
  await page.route("**/api/assistant/feature-branches", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ featureBranches: [OWN_BRANCH] }) });
  });

  await page.route("**/api/specs**", (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() !== "GET") return route.continue();
    if (!url.searchParams.has("path")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(tree()) });
    }
    const branch = url.searchParams.get("branch");
    const liveBranch = url.searchParams.get("liveBranch");
    const content = liveBranch === OWN_BRANCH ? "# Live content\n" : branch === FOREIGN_BRANCH ? "# Foreign draft content\n" : "unexpected request";
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ path: url.searchParams.get("path"), content }) });
  });
}

async function openBuildStudio(page: Page) {
  await page.getByTestId("dock-build-studio").click();
  const win = page.getByTestId("window-build-studio");
  await expect(win).toBeVisible();
  // Waits for the group header, not a file: every feature node now starts
  // collapsed, so this mock's spec.md files (one level below each feature)
  // never render without expanding their feature first.
  await expect(win.getByTestId("build-studio-tree").getByText("User specs")).toBeVisible({ timeout: 20000 });
  return win;
}

test.describe("Build Studio — draft content on your own live branch opens editable, not read-only", () => {
  test("own-branch draft content is editable and unbadged; a foreign branch's draft stays read-only", async ({ page }) => {
    await stubBackend(page);
    const win = await openBuildStudio(page);

    // --- Select OWN_BRANCH as this window's live editing branch ---
    const selector = win.getByLabel("Active feature branch");
    await expect(selector).toBeVisible({ timeout: 10000 });
    await selector.selectOption(OWN_BRANCH);
    await expect(win.getByTestId("user-specs-branch-badge")).toHaveText(OWN_BRANCH, { timeout: 10000 });

    const tree = win.getByTestId("build-studio-tree");

    // --- The own-branch feature node shows NO "Draft on ..." badge ---
    const ownFeatureRow = tree.locator(`[data-key="user-specs/proj/001-live-draft@${OWN_BRANCH}"]`);
    await ownFeatureRow.scrollIntoViewIfNeeded();
    await expect(ownFeatureRow).not.toContainText(OWN_BRANCH);
    await ownFeatureRow.click(); // expand it — collapsed by default

    // --- Opening its spec.md reads via liveBranch and is editable ---
    const ownFile = tree.locator(`[data-node-type="file"][data-key="user-specs/proj/001-live-draft/spec.md@${OWN_BRANCH}"]`);
    await ownFile.click();
    await expect(win.getByText("Live content")).toBeVisible({ timeout: 10000 });
    await expect(win.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
    await expect(win.getByText("read-only draft")).toHaveCount(0);

    // --- The foreign-branch feature node STILL shows its "Draft on ..." badge ---
    const foreignFeatureRow = tree.locator(`[data-key="user-specs/proj/002-foreign-draft@${FOREIGN_BRANCH}"]`);
    await foreignFeatureRow.scrollIntoViewIfNeeded();
    await expect(foreignFeatureRow).toContainText(FOREIGN_BRANCH);
    await foreignFeatureRow.click(); // expand it — collapsed by default

    // --- Opening ITS spec.md reads via the read-only draft path ---
    const foreignFile = tree.locator(`[data-node-type="file"][data-key="user-specs/proj/002-foreign-draft/spec.md@${FOREIGN_BRANCH}"]`);
    await foreignFile.click();
    await expect(win.getByText("Foreign draft content")).toBeVisible({ timeout: 10000 });
    await expect(win.getByText("read-only draft")).toBeVisible();
    await expect(win.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);

    // Leave the window's conversation branch cleared, same as it started.
    await selector.selectOption("");
  });
});
