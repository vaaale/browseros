import { test, expect, type Page } from "./fixtures";

// 041-tool-groups — Settings → Tools is group-first (US4). Covers what only a
// real browser can: collapsed-on-load, independent expansion, the group editor
// round-tripping, and the filter auto-expanding its matches.
//
// What this spec deliberately does NOT assert: that an edited group description
// reaches the model's system prompt. That path has no UI surface to observe, and
// it is already pinned by a unit test which drives the real builder
// (tests/assistant/tool-groups-block.test.ts, "a group description override
// appears in the block without a restart"). Asserting it here would mean
// scraping a live model call — slower, flakier, and no more truthful.
//
// FIXTURES: this spec creates and removes its own state via the real API. It
// never depends on pre-seeded data, and it resets the override it writes even
// when a test fails, so re-runs and concurrently-running specs see clean state.

const GROUP_ID = "web";
const CUSTOM_DESCRIPTION = "E2E-041 override — intranet only, no external access.";

async function openToolsTab(page: Page) {
  await page.getByTestId("dock-settings").click();
  const win = page.getByTestId("window-settings");
  await expect(win).toBeVisible();
  await win.locator("nav").getByRole("button", { name: "Tools", exact: true }).click();
  // The group headers render once /api/tool-groups + /api/tool-descriptions
  // have both resolved.
  await expect(win.getByRole("button", { name: /^Web, \d+ tools?$/ })).toBeVisible({ timeout: 15000 });
  return win;
}

async function resetGroup(page: Page) {
  await page.request.patch("/api/tool-groups", {
    data: { groupId: GROUP_ID, description: "", aliases: [] },
  });
}

test.describe.serial("041 — Settings → Tools, group-first", () => {
  test.afterEach(async ({ page }) => {
    await resetGroup(page);
  });

  test("groups render collapsed, and expand independently", async ({ page }) => {
    const win = await openToolsTab(page);

    // FR-043: collapsed on load — a tool id inside a group is not rendered yet.
    await expect(win.getByText("web_search", { exact: true })).toHaveCount(0);

    // FR-044: the header carries the group name and its tool count.
    const webHeader = win.getByRole("button", { name: /^Web,/ });
    await expect(webHeader).toHaveAttribute("aria-expanded", "false");

    await webHeader.click();
    await expect(webHeader).toHaveAttribute("aria-expanded", "true");
    await expect(win.getByText("web_search", { exact: true })).toBeVisible();

    // Expanding one group leaves the others alone.
    const filesHeader = win.getByRole("button", { name: /^Files,/ });
    await expect(filesHeader).toHaveAttribute("aria-expanded", "false");
    await expect(win.getByText("file_read", { exact: true })).toHaveCount(0);

    // ...and collapsing puts it back.
    await webHeader.click();
    await expect(win.getByText("web_search", { exact: true })).toHaveCount(0);
  });

  test("editing a group description saves and survives a reload", async ({ page }) => {
    const win = await openToolsTab(page);
    await win.getByRole("button", { name: /^Web,/ }).click();

    const editor = win.locator("textarea").first();
    await expect(editor).toBeVisible();
    const original = await editor.inputValue();
    expect(original.length).toBeGreaterThan(0);

    await editor.fill(CUSTOM_DESCRIPTION);
    await editor.blur();

    // Auto-save: no save button. Confirm it reached the server rather than
    // trusting local state.
    await expect
      .poll(
        async () => {
          const res = await page.request.get("/api/tool-groups");
          const body = (await res.json()) as { groups: { id: string; description: string }[] };
          return body.groups.find((g) => g.id === GROUP_ID)?.description;
        },
        { timeout: 10000 },
      )
      .toBe(CUSTOM_DESCRIPTION);

    // And it is what the UI shows after a full reload.
    await page.reload();
    const win2 = await openToolsTab(page);
    await win2.getByRole("button", { name: /^Web,/ }).click();
    await expect(win2.locator("textarea").first()).toHaveValue(CUSTOM_DESCRIPTION);

    // The built-in text is still offered as the source, so the edit is reversible.
    await expect(win2.getByText(/^Source:/)).toBeVisible();
  });

  test("Reset restores the built-in description", async ({ page }) => {
    await page.request.patch("/api/tool-groups", {
      data: { groupId: GROUP_ID, description: CUSTOM_DESCRIPTION },
    });

    const win = await openToolsTab(page);
    await win.getByRole("button", { name: /^Web,/ }).click();
    await expect(win.locator("textarea").first()).toHaveValue(CUSTOM_DESCRIPTION);

    await win.getByRole("button", { name: "Reset", exact: true }).first().click();

    await expect
      .poll(
        async () => {
          const res = await page.request.get("/api/tool-groups");
          const body = (await res.json()) as { groups: { id: string; overridden: boolean }[] };
          return body.groups.find((g) => g.id === GROUP_ID)?.overridden;
        },
        { timeout: 10000 },
      )
      .toBe(false);
  });

  test("the filter auto-expands the groups that match (FR-047)", async ({ page }) => {
    const win = await openToolsTab(page);

    const filter = win.getByPlaceholder("tool id, description or group");
    await filter.fill("wallpaper");

    // The matching group opens itself — collapsing everything would otherwise
    // make finding one tool harder, not easier.
    await expect(win.getByText("bos_wallpaper_set", { exact: true })).toBeVisible();
    // Non-matching groups stay shut, and groups with no match disappear.
    await expect(win.getByRole("button", { name: /^Gmail,/ })).toHaveCount(0);

    await win.getByRole("button", { name: "Clear", exact: true }).click();
    await expect(win.getByRole("button", { name: /^Gmail,/ })).toBeVisible();
    await expect(win.getByText("bos_wallpaper_set", { exact: true })).toHaveCount(0);
  });

  test("no fallback group is ever rendered (FR-041)", async ({ page }) => {
    const win = await openToolsTab(page);
    // The retired buckets, under any spelling.
    await expect(win.getByRole("button", { name: /^General,/ })).toHaveCount(0);
    await expect(win.getByRole("button", { name: /^Service Tools,/ })).toHaveCount(0);
    // And no capability is stranded in the unresolved-group error block.
    await expect(win.getByText("Unresolved tool group")).toHaveCount(0);
  });
});
