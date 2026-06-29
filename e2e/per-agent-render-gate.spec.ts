import { test, expect } from "@playwright/test";

// Regression guard (016-unified-agents): opening a conversation that contains a
// tool-call card for an action the active/pinned agent DISABLES must not crash
// CopilotChat. Before the fix, the gated shim registered a disallowed action with
// `available:"disabled"`; CopilotKit's getActionConfig routes a "disabled" action to
// its RENDER path (useRenderToolCall), which calls the action's `render`
// unconditionally — so a handler-only action (no render) threw
// "render is not a function" the moment its tool-call card rendered. The shim now
// registers disabled actions as a render-only no-op.
//
// We pin the Build Studio agent by opening a build-studio-group conversation (its
// group implies its agent). Build Studio's allowlist allows readDoc but NOT
// launchApp, so the seeded launchApp card is the disabled one.
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
        toolCalls: [{ id: "tc-launch", type: "function", function: { name: "launchApp", arguments: '{"appId":"chat"}' } }],
      },
      { id: "t1", role: "tool", content: "launched chat", toolCallId: "tc-launch" },
      {
        id: "a2",
        role: "assistant",
        content: "",
        toolCalls: [{ id: "tc-doc", type: "function", function: { name: "readDoc", arguments: `{"ref":"${DOCREF}"}` } }],
      },
      { id: "t2", role: "tool", content: "doc body", toolCallId: "tc-doc" },
      { id: "a3", role: "assistant", content: ANSWER },
    ],
  };

  test("a disabled action's tool card renders without crashing the chat", async ({ page, request }) => {
    test.setTimeout(60_000);
    await request.post("/api/fs", { data: { op: "write", path, content: JSON.stringify(convo) } });

    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    await page.goto("/");
    await page.getByTestId("dock-chat").click();
    await expect(page.getByTestId("window-chat")).toBeVisible();

    // Open the build-studio-group conversation (pins the Build Studio agent, whose
    // allowlist disables launchApp but allows readDoc).
    await page.getByRole("button", { name: TITLE, exact: true }).click();

    // The final answer renders — the chat got past the disabled-action card without
    // throwing.
    await expect(page.getByText(ANSWER)).toBeVisible();

    // The allowed action (readDoc) still renders its card via the catch-all renderer.
    await expect(page.getByRole("button", { name: /readDoc/ })).toBeVisible();

    // The disabled action (launchApp) is suppressed (render-only no-op), not crashing.
    await expect(page.getByRole("button", { name: /launchApp/ })).toHaveCount(0);

    // The regression: no uncaught "render is not a function" (and no page errors).
    expect(errors.join("\n")).not.toContain("render is not a function");
    expect(errors).toEqual([]);

    await request.post("/api/fs", { data: { op: "delete", path } });
  });
});
