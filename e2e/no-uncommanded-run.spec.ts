import { test as base, expect } from "@playwright/test";
import { trimToSettledTail } from "../src/lib/agent/conversations-sanitize";

// Regression guard for "the agent starts working uncommanded": reopening a
// conversation must NEVER resume an in-flight turn. A conversation persisted
// mid-run (trailing tool results, or assistant messages with pending tool calls)
// is trimmed on load to its last settled boundary, so CopilotKit has nothing to
// continue/re-execute. See src/lib/agent/conversations-sanitize.ts.
base.use({ video: "off" });

// ---- Unit: the trim logic (deterministic; the core of the fix) ----
base.describe("trimToSettledTail", () => {
  const user = { id: "u1", role: "user", content: "build a thing" };
  const asstCall = { id: "a1", role: "assistant", content: "", toolCalls: [{ id: "c1", type: "function", function: { name: "delegateToSubAgent", arguments: "{}" } }] };
  const toolRes = { id: "t1", role: "tool", toolCallId: "c1", content: "result" };
  const asstText = { id: "a2", role: "assistant", content: "Done — installed the app." };

  base("keeps a completed conversation intact (ends in assistant text)", async () => {
    const convo = [user, asstCall, toolRes, asstText];
    expect(trimToSettledTail(convo)).toEqual(convo);
  });

  base("drops a trailing in-flight turn (ends in tool results / pending calls)", async () => {
    // Mimics the real bug: one tool call with repeated/looping tool results, no final reply.
    const poisoned = [user, asstCall, toolRes, { ...toolRes, id: "t2" }, { ...toolRes, id: "t3" }];
    expect(trimToSettledTail(poisoned)).toEqual([user]);
  });

  base("drops a trailing assistant message that still has pending tool calls", async () => {
    expect(trimToSettledTail([user, asstText, { ...asstCall, content: "let me…" }])).toEqual([user, asstText]);
  });

  base("handles empty / all-in-flight conversations", async () => {
    expect(trimToSettledTail([])).toEqual([]);
    expect(trimToSettledTail([asstCall, toolRes])).toEqual([]);
  });
});

// ---- Integration: open a poisoned conversation, assert nothing runs ----
base.describe("opening a mid-run conversation is inert", () => {
  const CONV_ID = "c-poisoned-regression";
  const path = `/Documents/Chats/${CONV_ID}.json`;
  const poisoned = {
    id: CONV_ID,
    title: "Poisoned (regression)",
    createdAt: Date.now(),
    messages: [
      { id: "u1", role: "user", content: "Build me an app." },
      { id: "a1", role: "assistant", content: "", toolCalls: [{ id: "c1", type: "function", function: { name: "listFiles", arguments: "{}" } }] },
      { id: "t1", role: "tool", toolCallId: "c1", content: "[mid-run]" },
      { id: "t2", role: "tool", toolCallId: "c1", content: "[mid-run loop artifact]" },
    ],
  };

  base("loading it shows only the user message and triggers no run", async ({ page, context, request }) => {
    base.setTimeout(60_000);
    // Seed the poisoned conversation and make it the active one before any load.
    await request.post("/api/fs", { data: { op: "write", path, content: JSON.stringify(poisoned) } });
    await context.addInitScript((id) => localStorage.setItem("bos.activeConversation", id), CONV_ID);

    await page.goto("/");
    await page.getByTestId("dock-chat").click();
    await expect(page.getByTestId("window-chat")).toBeVisible();

    // The trimmed conversation is inert: no "Working…", no app candidate, and the
    // dangling tool-call/result tail is gone (only the user message remains).
    await page.waitForTimeout(8000);
    await expect(page.getByText("Working…")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Promote app" })).toHaveCount(0);

    // The persisted file must not have grown (no uncommanded messages appended).
    const after = await (await request.get(`/api/fs?op=read&path=${encodeURIComponent(path)}`)).json();
    const msgs = JSON.parse(after.content).messages as unknown[];
    expect(msgs.length).toBeLessThanOrEqual(poisoned.messages.length);

    // cleanup
    await request.post("/api/fs", { data: { op: "delete", path } });
  });
});
