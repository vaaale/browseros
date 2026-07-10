import { test, expect, type Route } from "@playwright/test";

// Reproduces the "Stop doesn't stop" report: mid tool call, clicking the chat
// input's Stop must (a) settle the hung handler with an in-band error, (b) NOT
// let CopilotKit start the automatic follow-up run (the "agent continues in the
// background" bug), and (c) leave no pending (yellow) tool call after switching
// away and back. Uses the fabricated-SSE recipe from tool-timeout.spec.ts: the
// /api/copilotkit single-route endpoint is intercepted so no live LLM is needed
// while the REAL client pipeline (CopilotKit → DocsActions → tool kernel) runs.
test.use({ video: "off" });

const CONV_ID = "c-stop-run-regression";
const CHAT_PATH = `/Documents/Chats/${CONV_ID}.json`;
const TITLE = "Stop run (regression)";

interface AgMessage {
  id?: string;
  role?: string;
  content?: string;
  toolCallId?: string;
}
interface RunInput {
  threadId?: string;
  runId?: string;
  messages?: AgMessage[];
  forwardedProps?: Record<string, unknown>;
}

const sse = (events: Record<string, unknown>[]): string =>
  events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

test.describe("Stop actually stops the run", () => {
  test("stop mid tool call: handler settles, no follow-up run, no pending call after switch", async ({
    page,
    context,
    request,
  }) => {
    test.setTimeout(120_000);

    // Seed the conversation and a second one to switch to.
    const OTHER_ID = "c-stop-run-other";
    await request.post("/api/fs", {
      data: {
        op: "write",
        path: CHAT_PATH,
        content: JSON.stringify({
          id: CONV_ID,
          title: TITLE,
          createdAt: Date.now(),
          agentId: "assistant",
          messages: [
            { id: "u1", role: "user", content: "Hello" },
            { id: "a1", role: "assistant", content: "Hi — ready." },
          ],
        }),
      },
    });
    await request.post("/api/fs", {
      data: {
        op: "write",
        path: `/Documents/Chats/${OTHER_ID}.json`,
        content: JSON.stringify({
          id: OTHER_ID,
          title: "Stop run (other)",
          createdAt: Date.now() - 1000,
          agentId: "assistant",
          messages: [{ id: "ou1", role: "user", content: "Other conversation" }],
        }),
      },
    });
    await context.addInitScript(
      (id) => localStorage.setItem("bos.activeConversation.assistant", id),
      CONV_ID,
    );

    // docs_list backend hangs forever.
    const hungRoutes: Route[] = [];
    await page.route(
      (url) => url.pathname === "/api/docs",
      (route) => {
        hungRoutes.push(route);
      },
    );

    // Fabricated model: first run emits a docs_list tool call; count every
    // subsequent agent/run POST (follow-ups) — after Stop there must be none.
    let runCount = 0;
    const runLog: string[] = [];
    await page.route(
      (url) => url.pathname === "/api/copilotkit",
      async (route) => {
        const req = route.request();
        if (req.method() !== "POST") return route.fallback();
        let envelope: { method?: string; body?: RunInput } | null = null;
        try {
          envelope = JSON.parse(req.postData() ?? "") as { method?: string; body?: RunInput };
        } catch {
          /* not a single-route envelope */
        }
        if (!envelope || envelope.method !== "agent/run") return route.fallback();
        const input = envelope.body ?? {};
        if (input.forwardedProps?.toolChoice) {
          // Suggestion runs are irrelevant here — settle them empty.
          return route.fulfill({
            status: 200,
            headers: { "content-type": "text/event-stream" },
            body: sse([
              { type: "RUN_STARTED", threadId: input.threadId ?? "t", runId: input.runId ?? "r" },
              { type: "RUN_FINISHED", threadId: input.threadId ?? "t", runId: input.runId ?? "r" },
            ]),
          });
        }
        runCount += 1;
        const last = (input.messages ?? [])[Math.max(0, (input.messages ?? []).length - 1)];
        runLog.push(`run#${runCount} last-role=${last?.role ?? "none"}`);
        const bookends = { threadId: input.threadId ?? "t", runId: input.runId ?? "r" };
        if (runCount === 1) {
          // The real-world failure signature: SEVERAL parallel tool calls in
          // one assistant turn. CopilotKit executes them sequentially, so a
          // Stop during call #1 must also settle the QUEUED calls #2-#4 —
          // before the stop-flag fix those kept executing ("the agent
          // continues in the background").
          const calls = ["tc-1", "tc-2", "tc-3", "tc-4"].flatMap((id) => [
            { type: "TOOL_CALL_START", toolCallId: id, toolCallName: "docs_list" },
            { type: "TOOL_CALL_ARGS", toolCallId: id, delta: "{}" },
            { type: "TOOL_CALL_END", toolCallId: id },
          ]);
          return route.fulfill({
            status: 200,
            headers: { "content-type": "text/event-stream" },
            body: sse([{ type: "RUN_STARTED", ...bookends }, ...calls, { type: "RUN_FINISHED", ...bookends }]),
          });
        }
        // Any later run answers instantly with text (if a follow-up sneaks
        // through we want it visible in assertions, not hanging).
        return route.fulfill({
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: sse([
            { type: "RUN_STARTED", ...bookends },
            { type: "TEXT_MESSAGE_START", messageId: `m-${runCount}`, role: "assistant" },
            { type: "TEXT_MESSAGE_CONTENT", messageId: `m-${runCount}`, delta: `FOLLOWUP_${runCount}` },
            { type: "TEXT_MESSAGE_END", messageId: `m-${runCount}` },
            { type: "RUN_FINISHED", ...bookends },
          ]),
        });
      },
    );

    try {
      await page.goto("/");
      const infoReady = page.waitForResponse(
        (r) =>
          r.url().includes("/api/copilotkit") &&
          r.request().method() === "POST" &&
          (r.request().postData() ?? "").includes('"method":"info"'),
        { timeout: 30_000 },
      );
      await page.getByTestId("dock-chat").click();
      const win = page.getByTestId("window-chat");
      await expect(win).toBeVisible();
      await page.getByRole("button", { name: TITLE, exact: true }).click();
      await infoReady;

      const input = win.getByRole("textbox").first();
      await input.fill("Trigger the hung tool call.");
      // Re-press Enter until the chat accepts the message (value clears on
      // send) — readiness has UI-internal async steps beyond the info response.
      await expect(async () => {
        await input.press("Enter");
        await expect(input).toHaveValue("", { timeout: 1_000 });
      }).toPass({ timeout: 20_000 });

      // The tool call is now executing (handler awaiting the hung /api/docs).
      // The input's single button must be a working Stop.
      const stopButton = win.getByTestId("copilot-send-button");
      await expect(stopButton).toHaveAttribute("aria-label", "Stop", { timeout: 15_000 });
      await stopButton.click();

      // (a) The RUNNING handler settles with the in-band abort error.
      await expect(page.getByText(/Error: docs_list: aborted by user/).first()).toBeVisible({
        timeout: 10_000,
      });

      // (b) The QUEUED handlers (#2-#4) settle as aborted too — instantly,
      // without executing. Assert via the persisted conversation: the
      // debounced save must show all 4 tool results as aborted.
      await expect(async () => {
        const res = await request.get(
          `/api/fs?op=read&path=${encodeURIComponent(CHAT_PATH)}`,
        );
        const { content } = (await res.json()) as { content?: string };
        const persisted = JSON.parse(content ?? "{}") as { messages?: AgMessage[] };
        const abortedResults = (persisted.messages ?? []).filter(
          (m) => m.role === "tool" && /aborted/.test(m.content ?? ""),
        );
        expect(abortedResults.length).toBe(4);
      }).toPass({ timeout: 15_000 });

      // (c) No follow-up run starts. Give the pipeline a beat to (wrongly)
      // launch one, then assert the run count stayed at 1 and no follow-up
      // text rendered.
      await page.waitForTimeout(4_000);
      expect(runLog.join("\n")).toBe("run#1 last-role=user");
      expect(runCount).toBe(1);
      await expect(page.getByText(/FOLLOWUP_/)).toHaveCount(0);

      // (c) Switch away and back: the restored conversation must have no
      // pending (running/yellow) tool call and no busy Stop button.
      await page.getByRole("button", { name: "Stop run (other)", exact: true }).click();
      await expect(page.getByText("Other conversation")).toBeVisible({ timeout: 15_000 });
      await page.getByRole("button", { name: TITLE, exact: true }).click();
      await expect(page.getByText(/Error: docs_list: aborted by user/).first()).toBeVisible({
        timeout: 15_000,
      });
      await page.waitForTimeout(2_000);
      expect(runCount).toBe(1);
      await expect(win.getByTestId("copilot-send-button")).toHaveAttribute("aria-label", "Send");
      // The activity pill must not report a running agent.
      await expect(page.getByText(/^Working/)).toHaveCount(0);
    } finally {
      for (const r of hungRoutes) await r.abort().catch(() => {});
      await request.post("/api/fs", { data: { op: "delete", path: CHAT_PATH } }).catch(() => {});
      await request
        .post("/api/fs", { data: { op: "delete", path: `/Documents/Chats/${OTHER_ID}.json` } })
        .catch(() => {});
    }
  });
});
