import { test, expect, type APIRequestContext } from "@playwright/test";

// Deterministic regression tests for the unified delegation engine
// (025-agent-delegation-v2). Request-fixture style (no browser), mirroring
// e2e/run-events-replay.spec.ts: drive the scripted e2e provider directly
// over HTTP and assert on the persisted event log / transcript. Never
// asserts on (nondeterministic) LLM-generated output — only on deterministic
// scripted tool names/results.

interface ScriptTurn {
  text: string;
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
      { timeout: 15_000 },
    )
    .toBeNull();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getEvents(request: APIRequestContext, runId: string): Promise<any[]> {
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

test.describe("agent delegation v2", () => {
  test("delegating to an agent whose allowlist includes a v2-only tool resolves it (US-1, SC-001)", async ({ request }) => {
    const conversationId = `e2e-025-us1-${Date.now()}`;
    const innerTask = script([
      { text: "rendering", tools: [{ name: "ui_preview_render", args: { surfaceId: "s1", operations: [] } }] },
      { text: "done" },
    ]);
    const message = script([
      { text: "delegating", tools: [{ name: "agent_delegate", args: { agent: "build-studio", task: innerTask } }] },
      { text: "Delegated." },
    ]);

    const runId = await startRun(request, conversationId, "assistant", message);
    await waitForFinish(request, conversationId);
    const events = await getEvents(request, runId);

    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult, "expected a tool_result for the agent_delegate call").toBeTruthy();
    expect(toolResult.result).not.toContain("unknown tool");
    expect(toolResult.result).not.toContain("Error:");

    const progress = events.find((e) => e.type === "tool_progress" && e.event?.tool === "ui_preview_render");
    expect(progress, "expected a live tool_progress event for ui_preview_render inside the inner loop").toBeTruthy();
  });

  test("an ephemeral delegate can call a tool inherited from the parent's allowlist immediately (US-2, SC-002)", async ({ request }) => {
    const conversationId = `e2e-025-us2-${Date.now()}`;
    const innerTask = script([
      { text: "searching", tools: [{ name: "memory_search", args: { query: "x" } }] },
      { text: "done searching" },
    ]);
    const message = script([
      {
        text: "delegating to ephemeral",
        tools: [
          {
            name: "agent_delegate",
            args: {
              ephemeralName: "Quick Helper",
              ephemeralSystemPrompt: "You help quickly.",
              ephemeralType: "local",
              task: innerTask,
            },
          },
        ],
      },
      { text: "Done." },
    ]);

    const runId = await startRun(request, conversationId, "assistant", message);
    await waitForFinish(request, conversationId);
    const events = await getEvents(request, runId);

    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult, "expected a tool_result for the ephemeral agent_delegate call").toBeTruthy();
    expect(toolResult.result).toContain("Quick Helper");
    expect(toolResult.result).not.toContain("unknown tool");
    expect(toolResult.result).not.toContain("Error:");

    const progress = events.find((e) => e.type === "tool_progress" && e.event?.tool === "memory_search");
    expect(progress, "expected memory_search (inherited, not in the ephemeral's own config) to actually be callable").toBeTruthy();
  });

  test("a multi-step delegation collapses to exactly one tool_call/tool_result (US-3, SC-005, Example 3)", async ({ request }) => {
    const conversationId = `e2e-025-us3-${Date.now()}`;
    const innerTask = script([
      { text: "step1", tools: [{ name: "memory_search", args: { query: "a" } }] },
      { text: "step2", tools: [{ name: "memory_search", args: { query: "b" } }] },
      { text: "step3", tools: [{ name: "memory_search", args: { query: "c" } }] },
      { text: "final answer" },
    ]);
    const message = script([
      { text: "delegating", tools: [{ name: "agent_delegate", args: { agent: "build-studio", task: innerTask } }] },
      { text: "Delegated." },
    ]);

    await startRun(request, conversationId, "assistant", message);
    await waitForFinish(request, conversationId);
    const messages = await getMessages(request, conversationId);

    const delegateCalls = messages.filter(
      (m) => m.role === "assistant" && (m.toolCalls ?? []).some((tc: { function: { name: string } }) => tc.function.name === "agent_delegate"),
    );
    expect(delegateCalls.length, "expected exactly one assistant message calling agent_delegate").toBe(1);

    const delegateCallIds = new Set(
      (delegateCalls[0].toolCalls ?? [])
        .filter((tc: { function: { name: string } }) => tc.function.name === "agent_delegate")
        .map((tc: { id: string }) => tc.id),
    );
    const toolResults = messages.filter((m) => m.role === "tool" && delegateCallIds.has(m.toolCallId));
    expect(toolResults.length, "expected exactly one tool-role message answering the agent_delegate call — not one per inner step").toBe(1);
  });

  test("an inner loop that exhausts its step cap returns the step-limit summary, not a hang (US-3 scenario 3, SC-008, Example 6)", async ({
    request,
  }) => {
    const conversationId = `e2e-025-stepcap-${Date.now()}`;
    // The ephemeral default step cap is 12 (no dev/spec-style tools inherited
    // from "assistant"'s own allowlist) — script more tool-call turns than that.
    const turns: ScriptTurn[] = Array.from({ length: 15 }, (_, i) => ({
      text: `turn ${i}`,
      tools: [{ name: "memory_search", args: { query: `q${i}` } }],
    }));
    const innerTask = script(turns);
    const message = script([
      {
        text: "delegating to ephemeral",
        tools: [
          {
            name: "agent_delegate",
            args: { ephemeralName: "Looper", ephemeralSystemPrompt: "Loop forever.", ephemeralType: "local", task: innerTask },
          },
        ],
      },
      { text: "Delegated." },
    ]);

    const runId = await startRun(request, conversationId, "assistant", message);
    await waitForFinish(request, conversationId);
    const events = await getEvents(request, runId);

    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult, "expected a tool_result for the exhausted delegation").toBeTruthy();
    expect(toolResult.result).toContain("Reached the step limit");
  });
});
