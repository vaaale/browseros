import { test, expect, type Page } from "./fixtures";

// Surface-agent lifecycle (025-agent-delegation-v2, US-4/US-5), browser-fixture
// (mirrors e2e/013-ui-preview.spec.ts / e2e/assistant-v2.spec.ts). Never
// asserts on (nondeterministic) LLM-generated text, only on deterministic
// scripted tool names/results.

const script = (turns: unknown[]) => `@@e2e ${JSON.stringify({ turns })}`;

/** Send a scripted message and wait for the run to FULLY finish (the stop
 *  button disappears) before returning — sequential sends in one test must
 *  not race the previous run, or the next POST /api/assistant/runs 409s. */
async function sendAndWaitForFinish(page: Page, message: string): Promise<void> {
  // Raise the Assistant window to the front first — UI Preview can visually
  // overlap it once open, and a plain/force click would otherwise land on
  // whichever window is actually on top instead of the real Send button.
  await page.getByRole("dialog", { name: "Assistant" }).click({ position: { x: 10, y: 10 } });
  await page.getByTestId("chat-textarea").click();
  await page.getByTestId("chat-textarea").fill(message);
  await page.getByTestId("chat-send-button").click();
  await expect(page.getByTestId("chat-stop-button")).toHaveCount(0, { timeout: 30_000 });
}

test.describe("surface agents", () => {
  test("full lifecycle: open, discover, delegate, close, rediscover fails (Example 2, US-4, SC-003, SC-004)", async ({ page }) => {
    await page.getByText("Assistant", { exact: true }).first().dblclick({ timeout: 20_000 });
    await expect(page.getByTestId("assistant-v2")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("chat-textarea")).toBeVisible({ timeout: 15_000 });

    // Open UI Preview — registers its surface agent.
    await sendAndWaitForFinish(
      page,
      script([{ text: "opening UI Preview", tools: [{ name: "ui_preview_open", args: {} }] }, { text: "Opened it." }]),
    );
    const win = page.getByTestId("window-ui-preview");
    await expect(win).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(500); // registerSurfaceAgent's collision check is async

    // Discover it via find_agent.
    await sendAndWaitForFinish(
      page,
      script([{ text: "finding agents", tools: [{ name: "find_agent", args: { query: "generate a UI mockup" } }] }, { text: "found it" }]),
    );
    const findCard = page.locator('[data-testid="tool-card"][data-tool="find_agent"]').last();
    await expect(findCard).toBeVisible({ timeout: 15_000 }); // already auto-expanded, newest card
    await expect(findCard.getByText(/"generative-ui-agent"/)).toBeVisible({ timeout: 10_000 });
    await expect(findCard.getByText(/"scope":"surface"/)).toBeVisible();

    // Delegate to it: the inner script calls a2ui_render + ui_preview_render.
    const innerTask = script([
      {
        text: "rendering",
        tools: [
          { name: "a2ui_render", args: { description: "a simple form" } },
          { name: "ui_preview_render", args: { surfaceId: "s1", operations: [] } },
        ],
      },
      { text: "Built a simple mockup." },
    ]);
    await sendAndWaitForFinish(
      page,
      script([
        { text: "delegating to the surface agent", tools: [{ name: "agent_delegate", args: { agent: "generative-ui-agent", task: innerTask } }] },
        { text: "Delegated." },
      ]),
    );
    const delegateCard = page.locator('[data-testid="tool-card"][data-tool="agent_delegate"]').last();
    await expect(delegateCard).toBeVisible({ timeout: 20_000 });
    // sendAndWaitForFinish already waited for the OUTER run to finish, so this
    // card's own result must already be settled — but allow a beat for the
    // final re-render.
    await expect(delegateCard).not.toHaveText(/running/i, { timeout: 15_000 });
    // Already auto-expanded (card-collapse's "newest insertion is expanded"
    // accordion rule) — do NOT click it, that would toggle it CLOSED. The
    // rendered card shows the NESTED payload's own output (the delegate's
    // final answer), not the "[agent · type] N step(s)" header prefix —
    // ToolCallCard.tsx's NestedEventList renders `nested.output` specifically.
    await expect(delegateCard.getByText("Built a simple mockup.", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(delegateCard.getByText(/unknown tool|no such agent|Error:/i)).toHaveCount(0);

    // Close UI Preview (the window chrome's tiny traffic-light close dot).
    // dispatchEvent fires the click DIRECTLY on the element via the DOM, with
    // no mouse-coordinate hit-testing — the Assistant window (last focused,
    // to send the delegation message) visually overlaps the same screen
    // position, which defeats a real/force mouse click here.
    await win.locator('button[aria-label="Close"]').dispatchEvent("click");
    await expect(win).toBeHidden({ timeout: 10_000 });
    await page.waitForTimeout(300);

    // A subsequent delegation attempt by the same id, in a NEW run, fails clearly.
    await sendAndWaitForFinish(
      page,
      script([
        { text: "delegating again", tools: [{ name: "agent_delegate", args: { agent: "generative-ui-agent", task: "anything" } }] },
        { text: "Tried." },
      ]),
    );
    const secondDelegateCard = page.locator('[data-testid="tool-card"][data-tool="agent_delegate"]').last();
    await expect(secondDelegateCard).toBeVisible({ timeout: 15_000 });
    await expect(secondDelegateCard.getByText(/no agent|not.*active|no such/i)).toBeVisible({ timeout: 10_000 });
  });

  test("no cross-call memory: a second delegation succeeds using only its own task string (US-5, SC-006)", async ({ page }) => {
    await page.getByText("Assistant", { exact: true }).first().dblclick({ timeout: 20_000 });
    await expect(page.getByTestId("assistant-v2")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("chat-textarea")).toBeVisible({ timeout: 15_000 });

    await sendAndWaitForFinish(
      page,
      script([{ text: "opening UI Preview", tools: [{ name: "ui_preview_open", args: {} }] }, { text: "Opened it." }]),
    );
    await expect(page.getByTestId("window-ui-preview")).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(500);

    // First delegation builds a mockup.
    const firstInner = script([
      {
        text: "rendering",
        tools: [
          { name: "a2ui_render", args: { description: "register form" } },
          { name: "ui_preview_render", args: { surfaceId: "s1", operations: [] } },
        ],
      },
      { text: "Built the register form." },
    ]);
    await sendAndWaitForFinish(
      page,
      script([
        { text: "delegating", tools: [{ name: "agent_delegate", args: { agent: "generative-ui-agent", task: firstInner } }] },
        { text: "Delegated once." },
      ]),
    );
    await expect(page.locator('[data-testid="tool-card"][data-tool="agent_delegate"]').last()).toBeVisible({ timeout: 20_000 });

    // Second delegation: the delegating agent's OWN task string supplies
    // continuity (Example 3's pattern) — the delegate itself never saw the first call.
    const secondInner = script([
      {
        text: "rendering",
        tools: [
          { name: "a2ui_render", args: { description: "register form with a larger submit button" } },
          { name: "ui_preview_render", args: { surfaceId: "s1", operations: [] } },
        ],
      },
      { text: "Made the submit button larger." },
    ]);
    await sendAndWaitForFinish(
      page,
      script([
        {
          text: "delegating again with context",
          tools: [
            {
              name: "agent_delegate",
              args: {
                agent: "generative-ui-agent",
                task: `The mockup currently has a register form. Make the submit button larger. ${secondInner}`,
              },
            },
          ],
        },
        { text: "Delegated twice." },
      ]),
    );
    const secondCard = page.locator('[data-testid="tool-card"][data-tool="agent_delegate"]').last();
    await expect(secondCard).toBeVisible({ timeout: 20_000 });
    await expect(secondCard.getByText(/unknown tool|no such agent|Error:/i)).toHaveCount(0);
  });
});
