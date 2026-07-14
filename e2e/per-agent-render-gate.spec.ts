import { test, expect } from "@playwright/test";

// Regression guard: opening a saved conversation whose transcript contains
// tool-call cards must render them (and the final answer) without throwing.
//
// History: under the retired CopilotKit chat path, a "disabled" action (one not
// in the active agent's allowlist) was routed to CopilotKit's render path and
// threw "render is not a function". The v2 assistant renders every transcript
// tool-call card the same way regardless of the agent's allowlist, so the
// crash can't happen — this test now just guards that rendering a transcript
// with tool cards is error-free.
test.use({ video: "off" });

test.describe("Per-agent render gate", () => {
  const CONV_ID = "c-render-gate-regression";
  const path = `/Documents/Chats/${CONV_ID}.json`;
  const TITLE = "Render gate (regression)";
  const ANSWER = "RENDER_GATE_ANSWER_7731";
  const DOCREF = "RENDER_GATE_DOCREF_7731";
  const convo = {
    id: CONV_ID,
    title: TITLE,
    createdAt: Date.now(),
    group: "build-studio",
    messages: [
      { id: "u1", role: "user", content: "open the chat app and read a doc" },
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [{ id: "tc-launch", type: "function", function: { name: "bos_app_launch", arguments: '{"appId":"chat"}' } }],
      },
      { id: "t1", role: "tool", content: "launched chat", toolCallId: "tc-launch" },
      {
        id: "a2",
        role: "assistant",
        content: "",
        toolCalls: [{ id: "tc-doc", type: "function", function: { name: "docs_read", arguments: `{"ref":"${DOCREF}"}` } }],
      },
      { id: "t2", role: "tool", content: "doc body", toolCallId: "tc-doc" },
      { id: "a3", role: "assistant", content: ANSWER },
    ],
  };

  test("a conversation with tool-call cards renders without crashing the chat", async ({ page, request }) => {
    test.setTimeout(60_000);
    await request.post("/api/fs", { data: { op: "write", path, content: JSON.stringify(convo) } });

    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    await page.goto("/");
    await page.getByTestId("dock-chat").click();
    await expect(page.getByTestId("window-chat")).toBeVisible();

    // Open the seeded conversation.
    await page.getByRole("button", { name: TITLE, exact: true }).click();

    // The final answer renders — the chat got past the tool-call cards.
    await expect(page.getByText(ANSWER)).toBeVisible();

    // Both tool-call cards render (the card container is present even when its
    // body is collapsed).
    await expect(page.locator('[data-testid="tool-card"][data-tool="bos_app_launch"]')).toBeVisible();
    await expect(page.locator('[data-testid="tool-card"][data-tool="docs_read"]')).toBeVisible();

    // The regression: no uncaught page errors (historically "render is not a function").
    expect(errors.join("\n")).not.toContain("render is not a function");
    expect(errors).toEqual([]);

    await request.post("/api/fs", { data: { op: "delete", path } });
  });
});
