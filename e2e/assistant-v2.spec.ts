import { test, expect, type Page } from "@playwright/test";

// v2 (server-owned runs) end-to-end. Determinism comes from the env-gated
// scripted provider (src/lib/assistant/e2e-provider.ts): with BOS_E2E_SCRIPTED=1
// a user message of the form `@@e2e {…}` drives the server loop from a script
// instead of the live model. These tests exercise the browser↔server
// integration that unit tests can't: NDJSON streaming, cross-client stop,
// reconnect replay, frontend-tool dispatch, and edit-resubmit.

const script = (turns: unknown[]) => `@@e2e ${JSON.stringify({ turns })}`;

async function openAssistantOnFreshConversation(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByText("Assistant", { exact: true }).first().dblclick({ timeout: 20000 });
  await expect(page.getByTestId("assistant-v2")).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("chat-textarea")).toBeVisible({ timeout: 15000 });
  // Start from a clean conversation so assertions don't collide with leftovers.
  // In allGroups mode the per-agent button is titled "New <Agent> conversation".
  await page.getByTitle(/New .*conversation/i).first().click();
  await page.waitForTimeout(400);
}

async function activeConversationId(page: Page): Promise<string> {
  // The main Assistant app resolves to the "assistant" agent; read ITS active
  // conversation specifically (other agents have their own keys).
  return page.evaluate(() => localStorage.getItem("bos.activeConversation.assistant") ?? "");
}

test.describe("Assistant v2 — server-owned runs", () => {
  test("frontend tool round-trip: scripted tool call → card → result → completion", async ({ page }) => {
    await openAssistantOnFreshConversation(page);
    await page.getByTestId("chat-textarea").fill(
      script([{ text: "listing apps", tools: [{ name: "bos_app_list", args: {} }] }, { text: "Done listing apps." }]),
    );
    await page.getByTestId("chat-send-button").click();

    await expect(page.getByTestId("tool-card").first()).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId("chat-stop-button")).toHaveCount(0, { timeout: 60000 });
    await expect(page.getByTestId("assistant-message").last()).toContainText("Done listing apps", { timeout: 10000 });

    // The frontend dispatch closed the loop: a tool result is persisted.
    const convId = await activeConversationId(page);
    const { messages } = await page.request
      .get(`/api/assistant/conversations/${convId}/messages`)
      .then((r) => r.json());
    expect(messages.some((m: { role: string }) => m.role === "tool")).toBeTruthy();
  });

  test("cross-client stop: cancel from another client kills the run; partial turn discarded", async ({ page }) => {
    await openAssistantOnFreshConversation(page);
    const long = "streaming ".repeat(30);
    await page.getByTestId("chat-textarea").fill(script([{ text: long, deltas: 40, delayMs: 200 }]));
    await page.getByTestId("chat-send-button").click();

    await expect(page.getByTestId("chat-stop-button")).toBeVisible({ timeout: 20000 });

    // A SEPARATE client (raw HTTP) cancels the conversation's active run.
    const convId = await activeConversationId(page);
    const run = await page.request.get(`/api/assistant/runs?conversationId=${convId}`).then((r) => r.json());
    expect(run.runId).toBeTruthy();
    await page.request.post(`/api/assistant/runs/${run.runId}/cancel`);

    // Tab A observes the server-side cancellation.
    await expect(page.getByText("Stopped.", { exact: true })).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("chat-stop-button")).toHaveCount(0, { timeout: 20000 });

    // Decision 2026-07-11: the interrupted turn is NOT persisted.
    const { messages } = await page.request
      .get(`/api/assistant/conversations/${convId}/messages`)
      .then((r) => r.json());
    expect(messages.filter((m: { role: string }) => m.role === "assistant")).toHaveLength(0);
    expect(messages.filter((m: { role: string }) => m.role === "user")).toHaveLength(1);
  });

  test("reconnect replay: reload mid-run and the run still completes", async ({ page }) => {
    await openAssistantOnFreshConversation(page);
    await page.getByTestId("chat-textarea").fill(
      script([{ text: "the run survives a reload and finishes cleanly", deltas: 20, delayMs: 250 }]),
    );
    await page.getByTestId("chat-send-button").click();
    await expect(page.getByTestId("chat-stop-button")).toBeVisible({ timeout: 20000 });

    // Reload mid-run — the server owns the run. Reloading closes the app window,
    // so re-open it; the reopened tab loads history + re-attaches to the run.
    await page.reload();
    await page.getByText("Assistant", { exact: true }).first().dblclick({ timeout: 20000 });
    await expect(page.getByTestId("assistant-v2")).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("assistant-message").last()).toContainText("survives a reload", { timeout: 60000 });
  });

  test("edit-resubmit rewinds the conversation", async ({ page }) => {
    await openAssistantOnFreshConversation(page);
    await page.getByTestId("chat-textarea").fill(script([{ text: "FIRST answer" }]));
    await page.getByTestId("chat-send-button").click();
    await expect(page.getByTestId("assistant-message").last()).toContainText("FIRST answer", { timeout: 60000 });
    await expect(page.getByTestId("chat-stop-button")).toHaveCount(0, { timeout: 30000 });

    await page.getByTestId("user-message").last().hover();
    await page.getByTestId("edit-message").click();
    await page.getByTestId("chat-textarea").fill(script([{ text: "SECOND answer" }]));
    await page.getByTestId("chat-send-button").click();

    await expect(page.getByTestId("assistant-message").last()).toContainText("SECOND answer", { timeout: 60000 });
    await expect(page.getByText("FIRST answer", { exact: false })).toHaveCount(0);
  });
});
