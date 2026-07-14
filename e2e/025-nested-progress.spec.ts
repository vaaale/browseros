import { test, expect } from "./fixtures";

// Live nested-progress rendering for a delegation (025-agent-delegation-v2,
// plan-review P2): while agent_delegate's inner loop is still running,
// its tool card must show the "running" state with at least one live
// {tool,input} nested entry — not just after it settles. Mirrors
// e2e/013-ui-preview.spec.ts's open-chat-and-send-scripted-message pattern.
// Never asserts on (nondeterministic) LLM-generated text, only on the
// deterministic scripted tool name.

const script = (turns: unknown[]) => `@@e2e ${JSON.stringify({ turns })}`;

test.describe("delegation live nested progress", () => {
  test("agent_delegate's tool card shows a running nested entry before the run finishes", async ({ page }) => {
    await page.getByText("Assistant", { exact: true }).first().dblclick({ timeout: 20_000 });
    await expect(page.getByTestId("assistant-v2")).toBeVisible({ timeout: 20_000 });
    const textarea = page.getByTestId("chat-textarea");
    await expect(textarea).toBeVisible({ timeout: 15_000 });

    // A delayMs on the inner turn keeps the run open long enough to observe
    // the live "running" state before it completes.
    const innerTask = script([
      { text: "slow rendering", deltas: 4, delayMs: 400, tools: [{ name: "memory_search", args: { query: "x" } }] },
      { text: "done" },
    ]);
    await textarea.fill(
      script([
        { text: "delegating", tools: [{ name: "agent_delegate", args: { agent: "build-studio", task: innerTask } }] },
        { text: "Delegated." },
      ]),
    );
    await page.getByTestId("chat-send-button").click();

    const card = page.locator('[data-testid="tool-card"][data-tool="agent_delegate"]');
    await expect(card).toBeVisible({ timeout: 15_000 });
    // WHILE the delegation is still running (before the run settles): the
    // card shows "running" and at least one live nested {tool,input} entry —
    // the concrete check that inner-loop.ts's event shaping actually reaches
    // the UI, not just the transport.
    await expect(card.getByText("running", { exact: false })).toBeVisible({ timeout: 5_000 });
    await expect(card.getByText("memory_search", { exact: false })).toBeVisible({ timeout: 5_000 });

    // Eventually settles cleanly (not stuck running forever).
    await expect(card.getByText("done", { exact: false })).toBeVisible({ timeout: 15_000 });
  });
});
