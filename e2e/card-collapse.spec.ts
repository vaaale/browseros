import { test, expect } from "@playwright/test";

// Regression guard for Assistant card collapsing (see src/lib/agent/card-collapse.ts
// + ChatToolRenderer/ReasoningAssistantMessage). Cards form an accordion: the
// newest insertion is expanded and earlier ones collapse, and clicking a card
// header toggles it. We drive the most testable path — a persisted assistant
// message with reasoning (<think>…</think>) followed by an answer — without
// needing a live model: on load the answer is a newer insertion than the
// reasoning, so the reasoning card must be collapsed, and its header must toggle.
test.use({ video: "off" });

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

  test("reasoning collapses under a newer answer and the header toggles it", async ({ page, context, request }) => {
    test.setTimeout(60_000);
    await request.post("/api/fs", { data: { op: "write", path, content: JSON.stringify(convo) } });
    await context.addInitScript((id) => localStorage.setItem("bos.activeConversation", id), CONV_ID);

    await page.goto("/");
    await page.getByTestId("dock-chat").click();
    await expect(page.getByTestId("window-chat")).toBeVisible();

    // The agent answer is always shown (never gated by collapse state).
    await expect(page.getByText(ANSWER)).toBeVisible();

    // The reasoning card header is present, but collapsed because the answer is a
    // newer insertion in the accordion — so the reasoning body is not rendered.
    const header = page.getByRole("button", { name: /Reasoning/ });
    await expect(header).toBeVisible();
    await expect(page.getByText(REASON)).toHaveCount(0);

    // Clicking the header expands it; clicking again collapses it.
    await header.click();
    await expect(page.getByText(REASON)).toBeVisible();
    await header.click();
    await expect(page.getByText(REASON)).toHaveCount(0);

    await request.post("/api/fs", { data: { op: "delete", path } });
  });
});
