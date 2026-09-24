import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { parseNested } from "../src/lib/agent/nested-events";

// 045-chat-live-tool — live per-tool updates & recursive tool-call rendering.
//
// Determinism comes from the env-gated scripted provider (e2e-provider.ts): with
// BOS_E2E_SCRIPTED=1 a `@@e2e {…}` message drives the server loop from a script.
// US1/US2 assertions read the run's PERSISTED event log over HTTP (browser-less,
// like e2e/run-events-replay.spec.ts and e2e/025-agent-delegation.spec.ts) so they
// observe the exact emission `seq` order the client store applies; US3 asserts the
// rendered card DOM in a real browser.
//
// US1 (T004 e2e leg): a batch of ≥2 parallel-safe calls with staggered completion
//   emits a distinct tool_result per callId AS EACH SETTLES (completion order),
//   while the persisted transcript stays in ORIGINAL call order; cancelling
//   mid-batch cancels each still-running call individually; an erroring call does
//   not hold its siblings.
// US2 (T006 e2e leg): a local/ephemeral delegation forwards nested tool RESULTS
//   live through the per-call tool_progress channel (not only nested starts).
// US3 (T009 e2e leg): a completed tool call renders as a recursive, collapsible
//   card (header action summary; independently-collapsible Input/Output;
//   content-type Output; child cards recurse for delegations).

interface ScriptTurn {
  text: string;
  deltas?: number;
  delayMs?: number;
  tools?: { name: string; args?: unknown }[];
}

function script(turns: ScriptTurn[]): string {
  return `@@e2e ${JSON.stringify({ turns })}`;
}

async function startRun(request: APIRequestContext, conversationId: string, agentId: string, message: string): Promise<string> {
  const res = await request.post("/api/assistant/runs", {
    data: { conversationId, agentId, message },
    headers: { "content-type": "application/json" },
  });
  expect(res.ok()).toBe(true);
  const { runId } = await res.json();
  expect(runId).toBeTruthy();
  return runId;
}

async function waitForFinish(request: APIRequestContext, conversationId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const probe = await request.get(`/api/assistant/runs?conversationId=${encodeURIComponent(conversationId)}`);
        const body = await probe.json();
        return body.runId;
      },
      { timeout: 30_000 },
    )
    .toBeNull();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RunEvent = any;

async function getEvents(request: APIRequestContext, runId: string): Promise<RunEvent[]> {
  const res = await request.get(`/api/assistant/runs/${encodeURIComponent(runId)}/events?since=0`);
  expect(res.status()).toBe(200);
  const body = await res.text();
  return body
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getMessages(request: APIRequestContext, conversationId: string): Promise<any[]> {
  const res = await request.get(`/api/assistant/conversations/${encodeURIComponent(conversationId)}/messages`);
  expect(res.ok()).toBe(true);
  const body = await res.json();
  return body.messages ?? [];
}

test.describe("045 — US1: per-settle individual completion", () => {
  test("a staggered parallel batch completes each call individually; the transcript stays in original order", async ({ request }) => {
    const conversationId = `e2e-045-us1-${Date.now()}`;
    // Two concurrent EPHEMERAL LOCAL delegations (agent_delegate is parallel-safe,
    // so they batch and run at the same time). A is the FIRST call and is SLOW; B
    // is the SECOND call and is FAST. So original/call order is [A, B] but
    // completion order is [B, A].
    const innerSlow = script([
      { text: "A working", deltas: 4, delayMs: 90, tools: [{ name: "memory_search", args: { query: "a" } }] },
      { text: "A done" },
    ]);
    const innerFast = script([
      { text: "B working", deltas: 2, delayMs: 15, tools: [{ name: "memory_search", args: { query: "b" } }] },
      { text: "B done" },
    ]);
    const message = script([
      {
        text: "delegating in parallel",
        tools: [
          { name: "agent_delegate", args: { ephemeralName: "Slow A", ephemeralType: "local", ephemeralSystemPrompt: "You are A.", task: innerSlow } },
          { name: "agent_delegate", args: { ephemeralName: "Fast B", ephemeralType: "local", ephemeralSystemPrompt: "You are B.", task: innerFast } },
        ],
      },
      { text: "done" },
    ]);

    const runId = await startRun(request, conversationId, "assistant", message);
    await waitForFinish(request, conversationId);
    const events = await getEvents(request, runId);

    // The two agent_delegate calls, in ORIGINAL (call) order: [A, B].
    const delegateCalls = events
      .filter((e) => e.type === "tool_call" && e.name === "agent_delegate")
      .map((e) => e.callId);
    expect(delegateCalls).toHaveLength(2);
    const [aId, bId] = delegateCalls;

    const aResult = events.find((e) => e.type === "tool_result" && e.callId === aId);
    const bResult = events.find((e) => e.type === "tool_result" && e.callId === bId);
    expect(aResult, "A must get its own tool_result").toBeTruthy();
    expect(bResult, "B must get its own tool_result").toBeTruthy();

    // FR-001 (completion order drives the live stream): the FAST second call (B)
    // completes before the SLOW first call (A). A single batched burst after the
    // slowest call would emit them in original order (A then B).
    expect(bResult.seq, "B (fast) must settle before A (slow)").toBeLessThan(aResult.seq);

    // FR-001 (per-settle, not a burst): A was still WORKING (emitting its own inner
    // tool_progress) after B had already completed — proof B's result was not held
    // for the whole batch.
    const aProgressAfterB = events.filter(
      (e) => e.type === "tool_progress" && e.callId === aId && e.seq > bResult.seq && e.seq < aResult.seq,
    );
    expect(aProgressAfterB.length, "A must still be streaming after B settled").toBeGreaterThan(0);

    // FR-002 (original-order persistence): the persisted transcript keeps A before B.
    const messages = await getMessages(request, conversationId);
    const toolMsgs = messages.filter((m) => m.role === "tool" && (m.toolCallId === aId || m.toolCallId === bId));
    expect(toolMsgs.map((m) => m.toolCallId)).toEqual([aId, bId]);
  });

  test("cancelling mid-batch flips each still-running call to cancelled individually", async ({ request }) => {
    const conversationId = `e2e-045-us1-cancel-${Date.now()}`;
    // Two long ephemeral delegations (parallel-safe → one batch). We cancel the
    // run while both are still running; each must receive its own tool_cancelled.
    const inner = (label: string) =>
      script([
        { text: `${label} start`, deltas: 40, delayMs: 250, tools: [{ name: "memory_search", args: { query: label } }] },
        { text: `${label} done` },
      ]);
    const message = script([
      {
        text: "delegating",
        tools: [
          { name: "agent_delegate", args: { ephemeralName: "L1", ephemeralType: "local", ephemeralSystemPrompt: "L1.", task: inner("l1") } },
          { name: "agent_delegate", args: { ephemeralName: "L2", ephemeralType: "local", ephemeralSystemPrompt: "L2.", task: inner("l2") } },
        ],
      },
      { text: "unreachable" },
    ]);
    const runId = await startRun(request, conversationId, "assistant", message);

    // Give the batch a moment to start, then cancel.
    await new Promise((r) => setTimeout(r, 400));
    const cancelRes = await request.post(`/api/assistant/runs/${encodeURIComponent(runId)}/cancel`);
    expect(cancelRes.ok()).toBe(true);
    await waitForFinish(request, conversationId);

    const events = await getEvents(request, runId);
    const delegateCalls = events.filter((e) => e.type === "tool_call" && e.name === "agent_delegate").map((e) => e.callId);
    expect(delegateCalls).toHaveLength(2);
    // FR-004: each still-running call gets its own tool_cancelled (exactly once),
    // promptly — not held until the batch would otherwise end.
    for (const id of delegateCalls) {
      expect(events.filter((e) => e.type === "tool_cancelled" && e.callId === id)).toHaveLength(1);
    }
    // The run finished as cancelled.
    const fin = events.find((e) => e.type === "run_finished");
    expect(fin?.reason).toBe("cancelled");
  });
});

test.describe("045 — US2: live nested output for delegations", () => {
  test("a local delegation streams each nested tool RESULT live (not only nested starts) and persists it", async ({ request }) => {
    const conversationId = `e2e-045-us2-${Date.now()}`;
    // An ephemeral LOCAL delegation whose inner run calls a server tool.
    const innerTask = script([
      { text: "searching", tools: [{ name: "memory_search", args: { query: "q1" } }] },
      { text: "final answer" },
    ]);
    const message = script([
      {
        text: "delegating",
        tools: [
          { name: "agent_delegate", args: { ephemeralName: "Researcher", ephemeralType: "local", ephemeralSystemPrompt: "You research.", task: innerTask } },
        ],
      },
      { text: "Delegated." },
    ]);

    const runId = await startRun(request, conversationId, "assistant", message);
    await waitForFinish(request, conversationId);
    const events = await getEvents(request, runId);

    const delegateCallId = events.find((e) => e.type === "tool_call" && e.name === "agent_delegate")!.callId;

    // FR-005: the parent card's LIVE tool_progress channel carries a nested
    // RESULT entry (type "tool_result"), not only the nested start.
    const nestedResult = events.find(
      (e) => e.type === "tool_progress" && e.callId === delegateCallId && e.event?.type === "tool_result" && e.event?.tool === "memory_search",
    );
    expect(nestedResult, "a nested tool_result must be streamed live via tool_progress").toBeTruthy();

    // FR-006 / B1: the terminal tool_result's nested list carries the per-child
    // result + status, so the child card rebuilds after a reload.
    const terminal = events.find((e) => e.type === "tool_result" && e.callId === delegateCallId);
    expect(terminal, "the delegation must produce a terminal tool_result").toBeTruthy();
    const nested = parseNested(terminal.result);
    expect(nested, "the terminal result must be a nested envelope").toBeTruthy();
    const child = nested!.events.find((ev) => ev.tool === "memory_search");
    expect(child, "the nested list must contain the memory_search child").toBeTruthy();
    expect(child!.result, "the child must carry its settled result (B1)").toBeTruthy();
    expect(child!.status).toBe("done");
  });
});

test.describe("045 — US3: recursive tool-call card (rendered DOM)", () => {
  async function openAssistantOnFreshConversation(page: Page): Promise<void> {
    await page.goto("/");
    await page.getByText("Assistant", { exact: true }).first().dblclick({ timeout: 20000 });
    await expect(page.getByTestId("assistant-v2")).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("chat-textarea")).toBeVisible({ timeout: 15000 });
    await page.getByTitle(/New .*conversation/i).first().click();
    await page.waitForTimeout(400);
  }

  test("a done delegation renders as a recursive card: human header, independent Input/Output, child cards", async ({ page }) => {
    test.setTimeout(90_000);
    await openAssistantOnFreshConversation(page);

    // A local delegation whose inner run calls a tool twice → the done card's
    // Output must render those as CHILD tool-call cards (recursion, FR-011/SC-010).
    const innerTask = script([
      { text: "step one", tools: [{ name: "memory_search", args: { query: "alpha" } }] },
      { text: "step two", tools: [{ name: "memory_search", args: { query: "beta" } }] },
      { text: "done researching" },
    ]);
    const message = script([
      {
        text: "delegating",
        tools: [
          { name: "agent_delegate", args: { ephemeralName: "Researcher", ephemeralType: "local", ephemeralSystemPrompt: "You research.", task: innerTask } },
        ],
      },
      { text: "Delegated and summarised." },
    ]);
    await page.getByTestId("chat-textarea").fill(message);
    await page.getByTestId("chat-send-button").click();
    await expect(page.getByTestId("chat-stop-button")).toHaveCount(0, { timeout: 60000 });
    await expect(page.getByTestId("assistant-message").last()).toContainText("Delegated and summarised", { timeout: 15000 });

    // The delegation card (top-level).
    const card = page.getByTestId("tool-card").filter({ has: page.getByRole("button", { name: "agent_delegate" }) });
    await expect(card).toBeVisible();

    // FR-012 / SC-006: the collapsed header is a human action summary, never a
    // raw JSON argument blob.
    const header = card.getByRole("button", { name: "agent_delegate" });
    await expect(header).toContainText("Delegate");
    await expect(header).not.toContainText("ephemeralName");
    await expect(header).not.toContainText("ephemeralSystemPrompt");

    // Open the card header (top-level uses the shared accordion; open regardless
    // of the loaded state).
    if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "true");

    // FR-015: both sections are present and independently collapsible (default
    // collapsed). Opening the Output section reveals the delegation's children.
    const output = card.getByTestId("tool-card-output");
    await expect(output).toBeVisible();
    const outputToggle = output.getByRole("button").first();
    if ((await outputToggle.getAttribute("aria-expanded")) !== "true") await outputToggle.click();
    await expect(outputToggle).toHaveAttribute("aria-expanded", "true");

    // FR-011 / SC-010: the Output renders CHILD tool-call cards — the same
    // component, recursed — one per inner tool call (memory_search ×2).
    const childCards = card.getByTestId("tool-card").filter({ has: page.getByRole("button", { name: "memory_search" }) });
    await expect(childCards).toHaveCount(2);

    // SC-006: each child is itself a full card whose collapsed HEADER is a
    // human summary with its key argument — "Memory search · alpha" — and never
    // a raw JSON argument blob. (Assert on the header button, not the whole
    // card: the card's body holds the sections' text even while hidden.)
    const childHeader = childCards.first().getByRole("button", { name: "memory_search" });
    await expect(childHeader).toContainText("Memory search");
    await expect(childHeader).toContainText("alpha");
    await expect(childHeader).not.toContainText("query");

    // A nested child's header is card-local (not the shared accordion) and
    // defaults COLLAPSED — and while it is closed its body (the Input/Output
    // section toggles) is visibility:hidden, so open the header FIRST;
    // clicking a hidden section toggle would wait forever.
    if ((await childHeader.getAttribute("aria-expanded")) !== "true") await childHeader.click();
    await expect(childHeader).toHaveAttribute("aria-expanded", "true");

    // FR-013: the child's Input section, when opened, shows structured key–value
    // (the primary "query" arg), not a raw JSON dump.
    const childInput = childCards.first().getByTestId("tool-card-input");
    const childInputToggle = childInput.getByRole("button").first();
    await childInputToggle.click();
    await expect(childInputToggle).toHaveAttribute("aria-expanded", "true");
    await expect(childInput).toContainText("alpha");
    await expect(childInput).not.toContainText("{");
  });
});
