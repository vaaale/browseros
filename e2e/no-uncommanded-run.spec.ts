import { test as base, expect } from "@playwright/test";
import { sanitizeLoadedMessages } from "../src/lib/agent/conversations-sanitize";

// Regression guard for "the agent starts working uncommanded": reopening a
// conversation must NEVER resume an in-flight turn. A conversation persisted
// mid-run (trailing tool results, or assistant messages with pending tool calls)
// is sanitized on load so CopilotKit has nothing to continue/re-execute — WITHOUT
// discarding history (a mid-run tail is closed with a settled note, not deleted).
// See src/lib/agent/conversations-sanitize.ts.
base.use({ video: "off" });

const NOTE_RE = /interrupted before the assistant replied/;

// ---- Unit: the sanitize logic (deterministic; the core of the fix) ----
base.describe("sanitizeLoadedMessages", () => {
  const user = { id: "u1", role: "user", content: "build a thing" };
  const asstCall = { id: "a1", role: "assistant", content: "", toolCalls: [{ id: "c1", type: "function", function: { name: "agent_delegate", arguments: "{}" } }] };
  const toolRes = { id: "t1", role: "tool", toolCallId: "c1", content: "result" };
  const asstText = { id: "a2", role: "assistant", content: "Done — installed the app." };

  base("keeps a completed conversation intact (ends in assistant text)", async () => {
    const convo = [user, asstCall, toolRes, asstText];
    expect(sanitizeLoadedMessages(convo)).toEqual(convo);
  });

  base("preserves a tool-heavy mid-run tail but closes it with a settled note", async () => {
    // The real bug: text+toolcall turns with a trailing tool result and no final
    // reply. History MUST be kept; a settled assistant note is appended so nothing
    // resumes (previously this was destroyed back to [user]).
    const poisoned = [user, asstCall, toolRes, { ...toolRes, id: "t2" }, { ...toolRes, id: "t3" }];
    const out = sanitizeLoadedMessages(poisoned) as { role?: string; content?: unknown }[];
    expect(out.slice(0, poisoned.length)).toEqual(poisoned);
    expect(out.length).toBe(poisoned.length + 1);
    expect(out[out.length - 1].role).toBe("assistant");
    expect(String(out[out.length - 1].content)).toMatch(NOTE_RE);
  });

  base("drops a trailing assistant message that still has pending tool calls", async () => {
    expect(sanitizeLoadedMessages([user, asstText, { ...asstCall, content: "let me…" }])).toEqual([user, asstText]);
  });

  base("handles empty / all-in-flight conversations", async () => {
    expect(sanitizeLoadedMessages([])).toEqual([]);
    // A dangling assistant call with its result: keep the result, append a note.
    const out = sanitizeLoadedMessages([asstCall, toolRes]) as { role?: string }[];
    expect(out.slice(0, 2)).toEqual([asstCall, toolRes]);
    expect(out[out.length - 1].role).toBe("assistant");
  });
});

// ---- Integration: open a mid-run conversation, assert nothing runs ----
base.describe("opening a mid-run conversation is inert", () => {
  const CONV_ID = "c-poisoned-regression";
  const path = `/Documents/Chats/${CONV_ID}.json`;
  const poisoned = {
    id: CONV_ID,
    title: "Poisoned (regression)",
    createdAt: Date.now(),
    messages: [
      { id: "u1", role: "user", content: "Build me an app." },
      { id: "a1", role: "assistant", content: "", toolCalls: [{ id: "c1", type: "function", function: { name: "file_list", arguments: "{}" } }] },
      { id: "t1", role: "tool", toolCallId: "c1", content: "[mid-run]" },
      { id: "t2", role: "tool", toolCallId: "c1", content: "[mid-run loop artifact]" },
    ],
  };

  base("loading it preserves history and triggers no run", async ({ page, context, request }) => {
    base.setTimeout(60_000);
    // Seed the poisoned conversation and make it the active one before any load.
    await request.post("/api/fs", { data: { op: "write", path, content: JSON.stringify(poisoned) } });
    await context.addInitScript((id) => localStorage.setItem("bos.activeConversation", id), CONV_ID);

    await page.goto("/");
    await page.getByTestId("dock-chat").click();
    await expect(page.getByTestId("window-chat")).toBeVisible();

    // The sanitized conversation is inert: no "Working…", no app candidate. The
    // history is preserved (not trimmed to the user message), and the only message
    // that may be appended is the settled "interrupted" note — never an agent run.
    await page.waitForTimeout(8000);
    await expect(page.getByText("Working…")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Promote app" })).toHaveCount(0);

    const after = await (await request.get(`/api/fs?op=read&path=${encodeURIComponent(path)}`)).json();
    const msgs = JSON.parse(after.content).messages as { role?: string; content?: unknown }[];
    // History kept (>= original) and only ever grown by the settled note, never by
    // agent-generated messages (no new tool calls / tool results).
    expect(msgs.length).toBeGreaterThanOrEqual(poisoned.messages.length);
    expect(msgs.filter((m) => m.role === "tool").length).toBe(2); // no NEW tool results
    for (const m of msgs.slice(poisoned.messages.length)) {
      expect(m.role).toBe("assistant");
      expect(String(m.content)).toMatch(NOTE_RE);
    }

    // cleanup
    await request.post("/api/fs", { data: { op: "delete", path } });
  });
});
