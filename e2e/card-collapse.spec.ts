import { test, expect, type Locator, type Page } from "@playwright/test";

// Regression guard for Assistant card collapsing (src/lib/agent/card-collapse.ts
// + the v2 chat renderer: MessageListV2's ReasoningBlock + ToolCallCard). Cards
// are collapsible: each has a header button (aria-expanded) whose body shows
// when open and hides when closed. We drive the deterministic path — a persisted
// assistant message with reasoning (<think>…</think>) / a tool call — and assert
// the header toggles the body, relative to whatever the on-load state is (the
// accordion opens the newest card, which varies with the transcript shape).
test.use({ video: "off" });

/** Assert a collapsible card header toggles its body open↔closed, starting from
 *  whatever state it loaded in. `bodyState` differs because the reasoning body
 *  is removed from the DOM when closed, while a tool card's body stays mounted
 *  but hidden. */
async function expectToggles(
  page: Page,
  header: Locator,
  body: Locator,
  bodyWhenClosed: "detached" | "hidden",
): Promise<void> {
  await expect(header).toBeVisible();
  const openThenClosed = async (): Promise<void> => {
    if (bodyWhenClosed === "detached") await expect(body).toHaveCount(0);
    else await expect(body).toBeHidden();
  };
  const startedOpen = (await header.getAttribute("aria-expanded")) === "true";
  if (startedOpen) await expect(body).toBeVisible();
  else await openThenClosed();

  await header.click();
  if (startedOpen) {
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await openThenClosed();
  } else {
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await expect(body).toBeVisible();
  }

  await header.click();
  if (startedOpen) {
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await expect(body).toBeVisible();
  } else {
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await openThenClosed();
  }
}

test.describe("Assistant card collapse", () => {
  const CONV_ID = "c-card-collapse-regression";
  const path = `/Documents/Chats/${CONV_ID}.json`;
  const REASON = "REASONING_TOKEN_4821";
  const ANSWER = "ANSWER_TOKEN_4821";
  const convo = {
    id: CONV_ID,
    title: "Card collapse (regression)",
    createdAt: Date.now(),
    messages: [
      { id: "u1", role: "user", content: "Hello there" },
      { id: "a1", role: "assistant", content: `<think>${REASON}</think>${ANSWER}` },
    ],
  };

  test("a reasoning card header toggles its body open/closed", async ({ page, context, request }) => {
    test.setTimeout(60_000);
    await request.post("/api/fs", { data: { op: "write", path, content: JSON.stringify(convo) } });
    await context.addInitScript((id) => localStorage.setItem("bos.activeConversation", id), CONV_ID);

    await page.goto("/");
    await page.getByTestId("dock-chat").click();
    await expect(page.getByTestId("window-chat")).toBeVisible();
    await page.getByRole("button", { name: "Card collapse (regression)", exact: true }).click();

    // The agent answer is always shown (never gated by collapse state).
    await expect(page.getByText(ANSWER)).toBeVisible();

    // The reasoning header toggles its body (removed from the DOM when closed).
    const header = page.getByRole("button", { name: /Reasoning/ });
    await expectToggles(page, header, page.getByText(REASON), "detached");

    await request.post("/api/fs", { data: { op: "delete", path } });
  });

  const TOOL_CONV_ID = "c-tool-card-collapse-regression";
  const toolPath = `/Documents/Chats/${TOOL_CONV_ID}.json`;
  const TOOL_ANSWER = "TOOL_ANSWER_TOKEN_9931";
  const DOCREF = "DOCREF_9931";
  const toolConvo = {
    id: TOOL_CONV_ID,
    title: "Tool card collapse (regression)",
    createdAt: Date.now(),
    messages: [
      { id: "tu1", role: "user", content: "Read a doc" },
      {
        id: "ta1",
        role: "assistant",
        content: "",
        toolCalls: [{ id: "tc-9931", type: "function", function: { name: "docs_read", arguments: `{"ref":"${DOCREF}"}` } }],
      },
      { id: "tt1", role: "tool", content: "TOOL_RESULT_TOKEN_9931", toolCallId: "tc-9931" },
      { id: "ta2", role: "assistant", content: TOOL_ANSWER },
    ],
  };

  test("a tool-call card header toggles its body open/closed", async ({ page, context, request }) => {
    test.setTimeout(60_000);
    await request.post("/api/fs", { data: { op: "write", path: toolPath, content: JSON.stringify(toolConvo) } });
    await context.addInitScript((id) => localStorage.setItem("bos.activeConversation", id), TOOL_CONV_ID);

    await page.goto("/");
    await page.getByTestId("dock-chat").click();
    await expect(page.getByTestId("window-chat")).toBeVisible();
    await page.getByRole("button", { name: "Tool card collapse (regression)", exact: true }).click();

    // The final answer is always shown.
    await expect(page.getByText(TOOL_ANSWER)).toBeVisible();

    // The tool card header toggles its body (stays mounted but hidden when closed).
    const header = page.getByRole("button", { name: /docs_read/ });
    await expectToggles(page, header, page.getByText(DOCREF), "hidden");

    await request.post("/api/fs", { data: { op: "delete", path: toolPath } });
  });
});
