import { test, expect, type Page } from "@playwright/test";

// 038-conversation-archive end-to-end. Covers the spec-level behaviors:
//   1. Archiving hides a conversation from the default list, moves it to the
//      collapsible Archived section, preserves its content, and renders it
//      read-only (US1 / FR-001/002/004/008).
//   2. The server is the authoritative read-only gate: POST /api/assistant/runs
//      returns 409 for an archived conversation and no run starts (FR-009).
//   3. Unarchiving restores the conversation to the default list with content
//      intact (US2 / FR-003).
//   4. Archive state is shared across app surfaces: archiving from Build
//      Studio's toolbar reflects in the Assistant panel with no reload, and
//      vice versa via the shared store (US3 / FR-005/007, SC-004).
//   5. Round 2 (T026/T027): the Assistant Archived section is collapsed by
//      default; archived conversations are absent from the Build Studio
//      dropdown entirely (FR-008 as amended); and promoting a feature branch
//      auto-archives the conversation(s) whose activeFeatureBranch is that
//      branch (US4 / FR-010, SC-006).
//
// All of these FAIL on the unfixed base: the row kebab menu
// (conv-row-menu/conv-menu-archive), the archived-section (and its round-2
// collapsible toggle), the Build Studio archive button, and the archive PATCH
// route do not exist there, POST /api/assistant/runs returns 201 instead of
// 409, and a promote leaves its conversations unarchived.
//
// Deterministic model turns come from the env-gated scripted provider
// (BOS_E2E_SCRIPTED=1, set by playwright.config.ts's webServer env — see
// src/lib/assistant/e2e-provider.ts).

const script = (turns: unknown[]) => `@@e2e ${JSON.stringify({ turns })}`;

async function openAssistantOnFreshConversation(page: Page): Promise<void> {
  await page.goto("/");
  const skip = page.getByRole("button", { name: "Skip" });
  if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {});
  await page.getByTestId("dock-chat").click();
  await expect(page.getByTestId("window-chat")).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("chat-textarea")).toBeVisible({ timeout: 15000 });
  // Start from a clean conversation so assertions don't collide with leftovers.
  // In allGroups mode the per-agent button is titled "New <Agent> conversation".
  await page.getByTitle(/New .*conversation/i).first().click();
  await page.waitForTimeout(400);
}

async function activeAssistantConversationId(page: Page): Promise<string> {
  return page.evaluate(() => localStorage.getItem("bos.activeConversation.assistant") ?? "");
}

/** Persist a scripted assistant turn so the conversation has real content. */
async function seedContent(page: Page, marker: string): Promise<void> {
  await page.getByTestId("chat-textarea").fill(script([{ text: marker }]));
  await page.getByTestId("chat-send-button").click();
  await expect(page.getByTestId("assistant-message").last()).toContainText(marker, { timeout: 60000 });
  await expect(page.getByTestId("chat-stop-button")).toHaveCount(0, { timeout: 30000 });
}

function rowIn(scope: Page | ReturnType<Page["getByTestId"]>, convId: string) {
  return scope.locator(`[data-conv-id="${convId}"]`);
}

/** The conversation's row inside (any) Archived section. The sections are
 *  collapsed by default (round 2, T021) — rows only exist in the DOM once the
 *  section has been expanded via expandArchivedSections. */
function archivedRow(win: ReturnType<Page["getByTestId"]>, convId: string) {
  return win.locator(`[data-testid="archived-section"] [data-conv-id="${convId}"]`);
}

/** Expand every collapsed Archived section in a window (one per agent bucket in
 *  the all-agents panel). The window must be frontmost — clicks on a covered
 *  window are intercepted by the one on top. */
async function expandArchivedSections(win: ReturnType<Page["getByTestId"]>) {
  const closed = win.locator('[data-testid="archived-section-toggle"][aria-expanded="false"]');
  while ((await closed.count()) > 0) await closed.first().click();
}

async function archiveViaRowMenu(win: ReturnType<Page["getByTestId"]>, convId: string, action: "archive" | "unarchive") {
  const row = rowIn(win, convId).first();
  await row.hover();
  await row.getByTestId("conv-row-menu").click();
  await row.getByTestId(`conv-menu-${action}`).click();
}

test.describe("038 conversation archive", () => {
  // Windows launch at 80% of the viewport, centered; on the default 720p
  // viewport that puts the composer/banner underneath the bottom-center dock
  // and notification bell overlays, which then intercept clicks. A taller
  // viewport keeps the whole window clear of them.
  test.use({ viewport: { width: 1600, height: 1000 } });

  test("archive hides from the default list, shows in Archived, preserves content, read-only (US1)", async ({ page }) => {
    await openAssistantOnFreshConversation(page);
    const marker = `ARCHIVE-CONTENT-${Date.now()}`;
    await seedContent(page, marker);
    const convId = await activeAssistantConversationId(page);
    expect(convId).toBeTruthy();
    const win = page.getByTestId("window-chat");

    // The row starts in the default block, not in an Archived section.
    await expect(rowIn(win, convId)).toHaveCount(1);
    await expect(archivedRow(win, convId)).toHaveCount(0);

    await archiveViaRowMenu(win, convId, "archive");

    // The default list shrank by one: with the Archived section still collapsed
    // (its resting state), the conversation has no row anywhere.
    await expect(rowIn(win, convId)).toHaveCount(0, { timeout: 10000 });

    // Expanding the Archived section reveals exactly one row for it.
    await expandArchivedSections(win);
    await expect(archivedRow(win, convId)).toHaveCount(1, { timeout: 10000 });
    await expect(rowIn(win, convId)).toHaveCount(1);

    // Self-archive (ADR-6): the open conversation stays open and goes
    // read-only — banner + locked composer, no textarea.
    await expect(win.getByTestId("archived-banner")).toBeVisible();
    await expect(win.getByTestId("archived-composer-lock")).toBeVisible();
    await expect(win.getByTestId("chat-textarea")).toHaveCount(0);

    // Content is fully preserved: still rendered, and intact on the server.
    await expect(win.getByTestId("assistant-message").last()).toContainText(marker);
    const { messages } = await page.request
      .get(`/api/assistant/conversations/${convId}/messages`)
      .then((r) => r.json());
    expect(JSON.stringify(messages)).toContain(marker);

    // The banner's own affordance restores the composer (FR-003 fast path).
    await win.getByTestId("archived-banner-unarchive").click();
    await expect(win.getByTestId("chat-textarea")).toBeVisible({ timeout: 10000 });
    await expect(archivedRow(win, convId)).toHaveCount(0);
  });

  test("server gate: POST /api/assistant/runs returns 409 for an archived conversation (FR-009)", async ({ page }) => {
    await openAssistantOnFreshConversation(page);
    const convId = await activeAssistantConversationId(page);
    expect(convId).toBeTruthy();

    // Archive through the dedicated endpoint (the client's file write is
    // queued, so poll until the conversation file exists server-side).
    await expect(async () => {
      const res = await page.request.patch(`/api/assistant/conversations/${convId}/archive`, {
        data: { archived: true },
      });
      expect(res.status()).toBe(200);
    }).toPass({ timeout: 10000 });

    // Bad body and unknown conversation are rejected.
    const bad = await page.request.patch(`/api/assistant/conversations/${convId}/archive`, {
      data: { archived: "yes" },
    });
    expect(bad.status()).toBe(400);
    const missing = await page.request.patch(`/api/assistant/conversations/does-not-exist-038/archive`, {
      data: { archived: true },
    });
    expect(missing.status()).toBe(404);

    // The single send funnel refuses the archived conversation…
    const send = await page.request.post("/api/assistant/runs", {
      data: { conversationId: convId, agentId: "assistant", message: "hello?" },
    });
    expect(send.status()).toBe(409);
    const body = await send.json();
    expect(String(body.error)).toContain("archived");

    // …and no run was started.
    const run = await page.request.get(`/api/assistant/runs?conversationId=${convId}`).then((r) => r.json());
    expect(run.runId).toBeNull();

    // Unarchive → the same send is accepted again (read-only is reversible).
    const restore = await page.request.patch(`/api/assistant/conversations/${convId}/archive`, {
      data: { archived: false },
    });
    expect(restore.status()).toBe(200);
    const resend = await page.request.post("/api/assistant/runs", {
      data: { conversationId: convId, agentId: "assistant", message: script([{ text: "post-unarchive turn" }]) },
    });
    expect(resend.status()).toBe(201);
  });

  test("unarchive from the Archived section restores the conversation, content unchanged (US2)", async ({ page }) => {
    await openAssistantOnFreshConversation(page);
    const marker = `RESTORE-CONTENT-${Date.now()}`;
    await seedContent(page, marker);
    const convId = await activeAssistantConversationId(page);
    const win = page.getByTestId("window-chat");

    await archiveViaRowMenu(win, convId, "archive");
    // The section is collapsed by default — expand it to reach the row.
    await expandArchivedSections(win);
    await expect(archivedRow(win, convId)).toHaveCount(1, { timeout: 10000 });

    // Unarchive from the archived row's own menu.
    await archiveViaRowMenu(win, convId, "unarchive");

    // Back in the default block, gone from the Archived section, composer live.
    await expect(archivedRow(win, convId)).toHaveCount(0, { timeout: 10000 });
    await expect(rowIn(win, convId)).toHaveCount(1);
    await expect(win.getByTestId("chat-textarea")).toBeVisible();
    await expect(win.getByTestId("archived-banner")).toHaveCount(0);

    // Content survived the archive → unarchive round-trip (SC-002).
    await expect(win.getByTestId("assistant-message").last()).toContainText(marker);
    const { messages } = await page.request
      .get(`/api/assistant/conversations/${convId}/messages`)
      .then((r) => r.json());
    expect(JSON.stringify(messages)).toContain(marker);
  });

  test("cross-app: archive state is shared between Build Studio and the Assistant panel (US3)", async ({ page }) => {
    await page.goto("/");
    const skip = page.getByRole("button", { name: "Skip" });
    if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {});

    // Open Build Studio and create a fresh conversation from its toolbar.
    await page.getByTestId("dock-build-studio").click();
    const bsWin = page.getByTestId("window-build-studio");
    await expect(bsWin).toBeVisible({ timeout: 20000 });
    const selector = bsWin.getByTestId("conversation-selector");
    await expect(selector).toBeVisible({ timeout: 20000 });
    await selector.selectOption("__new__");
    await expect(async () => {
      const id = await page.evaluate(() => localStorage.getItem("bos.activeConversation.build-studio") ?? "");
      expect(id).toBeTruthy();
    }).toPass({ timeout: 10000 });
    const convId = await page.evaluate(() => localStorage.getItem("bos.activeConversation.build-studio") ?? "");

    // Open the Assistant app beside it — its all-agents panel lists the same
    // conversation under the Build Studio agent's bucket (shared store).
    await page.getByTestId("dock-chat").click();
    const chatWin = page.getByTestId("window-chat");
    await expect(chatWin).toBeVisible({ timeout: 20000 });
    await expect(rowIn(chatWin, convId)).toHaveCount(1, { timeout: 15000 });
    await expect(archivedRow(chatWin, convId)).toHaveCount(0);

    // Archive from Build Studio's toolbar button (the active conversation).
    // Windows overlap (both launch at 80% viewport) — a dock click re-fronts
    // the open Build Studio window so its toolbar is clickable.
    await page.getByTestId("dock-build-studio").click();
    await bsWin.getByTestId("conversation-archive-button").click();

    // No reload: the archived conversation vanished from Build Studio's
    // <select> entirely — no option, no Archived optgroup (FR-008 as amended,
    // round 2 / T022) — while the Assistant panel moved the row into its
    // agent's (collapsed) Archived sub-section (FR-005 / SC-004).
    await expect(
      bsWin.locator(`select[data-testid="conversation-selector"] option[value="${convId}"]`),
    ).toHaveCount(0, { timeout: 10000 });
    await expect(bsWin.locator('select[data-testid="conversation-selector"] optgroup')).toHaveCount(0);
    await page.getByTestId("dock-chat").click(); // re-front the Assistant window
    await expandArchivedSections(chatWin);
    await expect(archivedRow(chatWin, convId)).toHaveCount(1, { timeout: 10000 });

    // And back: unarchive from the ASSISTANT panel, observe Build Studio.
    await archiveViaRowMenu(chatWin, convId, "unarchive");
    await expect(archivedRow(chatWin, convId)).toHaveCount(0, { timeout: 10000 });
    await expect(
      bsWin.locator(`select[data-testid="conversation-selector"] option[value="${convId}"]`),
    ).toHaveCount(1);
  });

  test("round 2: Archived section is collapsed by default; Build Studio dropdown hides archived entirely (T027)", async ({ page }) => {
    await openAssistantOnFreshConversation(page);
    const convId = await activeAssistantConversationId(page);
    expect(convId).toBeTruthy();
    const win = page.getByTestId("window-chat");

    await archiveViaRowMenu(win, convId, "archive");

    // Collapsed at rest (T021): every section's header toggle is closed, and
    // neither the archived rows nor the empty-state text are in the DOM.
    const toggle = win.getByTestId("archived-section-toggle").first();
    await expect(toggle).toBeVisible();
    await expect(win.locator('[data-testid="archived-section-toggle"][aria-expanded="true"]')).toHaveCount(0);
    await expect(archivedRow(win, convId)).toHaveCount(0);
    await expect(win.getByText("Nothing archived yet.")).toHaveCount(0);

    // Expanding reveals the row; collapsing its section hides it again without
    // touching the archived flag (re-expanding brings it right back).
    await expandArchivedSections(win);
    await expect(archivedRow(win, convId)).toHaveCount(1, { timeout: 10000 });
    const section = win.locator('[data-testid="archived-section"]', {
      has: page.locator(`[data-conv-id="${convId}"]`),
    });
    await section.getByTestId("archived-section-toggle").click();
    await expect(archivedRow(win, convId)).toHaveCount(0);
    await expandArchivedSections(win);
    await expect(archivedRow(win, convId)).toHaveCount(1);

    // Build Studio (T022/T023): archived conversations are absent from the
    // dropdown entirely — no option, no optgroup — and the toolbar button is
    // archive-only, so it has nothing to act on once the active conversation
    // is archived.
    await page.getByTestId("dock-build-studio").click();
    const bsWin = page.getByTestId("window-build-studio");
    await expect(bsWin).toBeVisible({ timeout: 20000 });
    const selector = bsWin.getByTestId("conversation-selector");
    await expect(selector).toBeVisible({ timeout: 20000 });
    await selector.selectOption("__new__");
    await expect(async () => {
      const id = await page.evaluate(() => localStorage.getItem("bos.activeConversation.build-studio") ?? "");
      expect(id).toBeTruthy();
    }).toPass({ timeout: 10000 });
    const bsConvId = await page.evaluate(() => localStorage.getItem("bos.activeConversation.build-studio") ?? "");
    await expect(selector.locator(`option[value="${bsConvId}"]`)).toHaveCount(1);

    await bsWin.getByTestId("conversation-archive-button").click();
    await expect(selector.locator(`option[value="${bsConvId}"]`)).toHaveCount(0, { timeout: 10000 });
    await expect(selector.locator("optgroup")).toHaveCount(0);
    await expect(bsWin.getByTestId("conversation-archive-button")).toBeDisabled();
  });

  test("promote auto-archives the conversations on that feature branch (US4 / FR-010 / T026)", async ({ page }) => {
    const branch = "bos/testfixture-e2e-archive-promote";
    // The Supervisor is not running in e2e — mock its control surface (same
    // pattern as 037-item-store-activation) so the topbar VersionControls
    // renders with `branch` previewing and Promote enabled. The promote job
    // itself "succeeds" instantly; everything after it — the settle notice,
    // the auto-archive, the reload — is the real client code under test.
    await page.route("**/__supervisor/state", (route) =>
      route.fulfill({
        json: {
          base: { role: "base", state: "ready" },
          previews: [{ role: "preview", branch, state: "ready" }],
          baseBranch: "main",
          serving: { role: "preview", branch },
        },
      }));
    await page.route("**/__supervisor/branches", (route) =>
      route.fulfill({ json: { branches: ["main", branch], base: "main" } }));
    await page.route("**/__supervisor/promote", (route) =>
      route.fulfill({ json: { ok: true, jobId: "e2e-job-038" } }));
    await page.route("**/__supervisor/promote-status*", (route) =>
      route.fulfill({ json: { ok: true, status: "done" } }));
    await page.route("**/__supervisor/pin", (route) => route.fulfill({ json: { ok: true } }));

    // Two conversations on the same branch — a promote archives all of them.
    await openAssistantOnFreshConversation(page);
    const marker = `PROMOTE-CONTENT-${Date.now()}`;
    await seedContent(page, marker);
    const convA = await activeAssistantConversationId(page);
    expect(convA).toBeTruthy();
    await page.getByTitle(/New .*conversation/i).first().click();
    await expect(async () => {
      const id = await activeAssistantConversationId(page);
      expect(id).toBeTruthy();
      expect(id).not.toBe(convA);
    }).toPass({ timeout: 10000 });
    const convB = await activeAssistantConversationId(page);
    for (const id of [convA, convB]) {
      const res = await page.request.patch("/api/assistant/feature-branches", {
        data: { conversationId: id, branch },
      });
      expect(res.ok()).toBeTruthy();
    }

    // Reload before promoting: the branch link above was written server-side,
    // so this page's already-populated store snapshot doesn't have it — and the
    // point of ADR-7 is that the auto-archive helper loads the lazy store
    // itself rather than relying on a chat window having populated it.
    await page.reload();

    // Promote from the desktop topbar. promoteAndWait polls the mocked job to
    // "done", then the handler awaits the auto-archive PATCHes and reloads.
    const reloaded = page.waitForEvent("load", { timeout: 60000 });
    await page.getByRole("button", { name: "Promote" }).click();
    await reloaded;

    // Both conversations are archived: absent from the default list, present
    // in the Archived section once expanded, content intact (SC-006).
    await page.getByTestId("dock-chat").click();
    const win = page.getByTestId("window-chat");
    await expect(win).toBeVisible({ timeout: 20000 });
    await expect(win.getByTestId("archived-section-toggle").first()).toBeVisible({ timeout: 15000 });
    await expect(rowIn(win, convA)).toHaveCount(0);
    await expect(rowIn(win, convB)).toHaveCount(0);
    await expandArchivedSections(win);
    await expect(archivedRow(win, convA)).toHaveCount(1, { timeout: 10000 });
    await expect(archivedRow(win, convB)).toHaveCount(1);

    const { messages } = await page.request
      .get(`/api/assistant/conversations/${convA}/messages`)
      .then((r) => r.json());
    expect(JSON.stringify(messages)).toContain(marker);

    // Still restorable, exactly like a manually archived conversation.
    await archiveViaRowMenu(win, convA, "unarchive");
    await expect(archivedRow(win, convA)).toHaveCount(0, { timeout: 10000 });
    await expect(rowIn(win, convA)).toHaveCount(1);
  });
});
