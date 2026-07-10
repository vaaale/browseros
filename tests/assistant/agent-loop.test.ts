// Agent-loop behavior with a scripted provider (no LLM, no framework):
//   npx playwright test -c playwright.unit.config.ts

import { test } from "@playwright/test";
import { strict as assert } from "node:assert";

import { runAgentLoop, type AgentLoopDeps, type StreamTurn, type TurnResult } from "../../src/lib/assistant/agent-loop";
import type { ChatMessage } from "../../src/lib/assistant/messages";
import type { RunEventInput } from "../../src/lib/assistant/run-events";
import type { AssistantTool, ToolGateConfig } from "../../src/lib/assistant/tools";
import type { FrontendOutcome } from "../../src/lib/assistant/run-manager";
import type { RunHooks } from "../../src/lib/assistant/hooks";

type TurnScript = TurnResult | ((opts: Parameters<StreamTurn>[0]) => Promise<TurnResult>);

function scriptedProvider(turns: TurnScript[]): StreamTurn {
  let i = 0;
  return async (opts) => {
    const turn = turns[i++];
    if (!turn) throw new Error(`scripted provider exhausted at turn ${i}`);
    return typeof turn === "function" ? turn(opts) : turn;
  };
}

function openGate(): ToolGateConfig {
  return { allow: new Set(), deferred: new Set(), registryIds: new Set(), descriptions: {} };
}

interface Harness {
  deps: AgentLoopDeps;
  store: { messages: ChatMessage[] };
  events: RunEventInput[];
  abort: AbortController;
}

function harness(opts: {
  turns: TurnScript[];
  tools?: Record<string, AssistantTool>;
  initial?: ChatMessage[];
  maxSteps?: number;
  toolTimeoutMs?: number;
  frontend?: (callId: string) => Promise<FrontendOutcome>;
  hooks?: RunHooks;
}): Harness {
  const store = { messages: [...(opts.initial ?? [])] };
  const events: RunEventInput[] = [];
  const abort = new AbortController();
  const deps: AgentLoopDeps = {
    runId: "run-test",
    conversationId: "c-test",
    agentId: "default_agent",
    signal: abort.signal,
    emit: (e) => events.push(e),
    streamTurn: scriptedProvider(opts.turns),
    composeSystem: async () => "system prompt",
    tools: opts.tools ?? {},
    gate: openGate(),
    io: {
      loadMessages: async () => [...store.messages],
      saveMessages: async (m) => {
        store.messages = [...m];
      },
    },
    awaitFrontendResult: opts.frontend
      ? (callId) => opts.frontend!(callId)
      : async () => ({ kind: "timeout" }),
    maxSteps: opts.maxSteps ?? 8,
    toolTimeoutMs: opts.toolTimeoutMs ?? 500,
    hooks: opts.hooks,
  };
  return { deps, store, events, abort };
}

const call = (id: string, name: string, args = "{}") => ({ id, name, arguments: args });

function assertNoUnansweredCalls(messages: ChatMessage[]) {
  const answered = new Set(messages.filter((m) => m.role === "tool").map((m) => m.toolCallId));
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const tc of m.toolCalls ?? []) {
      assert.ok(answered.has(tc.id), `tool call ${tc.id} has no answer in the transcript`);
    }
  }
}

test.describe("agent loop — happy path", () => {
  test("runs turn → server tool → final text, persisting a settled transcript", async () => {
    const echo: AssistantTool = {
      name: "echo",
      description: "echoes",
      parameters: { type: "object", properties: {} },
      execution: "server",
      execute: async (input) => `echo:${JSON.stringify(input)}`,
    };
    const h = harness({
      turns: [
        { text: "let me check", toolCalls: [call("c1", "echo", '{"x":1}')] },
        { text: "done", toolCalls: [] },
      ],
      tools: { echo },
    });
    const result = await runAgentLoop(h.deps, { userMessage: { content: "hi" } });

    assert.equal(result.reason, "completed");
    const roles = h.store.messages.map((m) => m.role);
    assert.deepEqual(roles, ["user", "assistant", "tool", "assistant"]);
    assert.equal(h.store.messages[2].content, 'echo:{"x":1}');
    assert.equal(h.store.messages[2].toolCallId, "c1");
    assertNoUnansweredCalls(h.store.messages);
    const types = h.events.map((e) => e.type);
    assert.ok(types.includes("tool_call") && types.includes("tool_result"));
    assert.equal(h.events.filter((e) => e.type === "message").length, 4);
  });

  test("streams deltas through emit", async () => {
    const h = harness({
      turns: [
        async (opts) => {
          opts.onDelta({ kind: "reasoning", messageId: opts.messageId, delta: "thinking…" });
          opts.onDelta({ kind: "text", messageId: opts.messageId, delta: "hel" });
          opts.onDelta({ kind: "text", messageId: opts.messageId, delta: "lo" });
          return { text: "hello", toolCalls: [] };
        },
      ],
    });
    const result = await runAgentLoop(h.deps, { userMessage: { content: "hi" } });
    assert.equal(result.reason, "completed");
    assert.equal(h.events.filter((e) => e.type === "text_delta").length, 2);
    assert.equal(h.events.filter((e) => e.type === "reasoning_delta").length, 1);
  });
});

test.describe("agent loop — stop semantics", () => {
  test("stop mid model turn discards the partial turn entirely", async () => {
    const h = harness({
      turns: [
        (opts) =>
          new Promise((_, reject) => {
            opts.onDelta({ kind: "text", messageId: opts.messageId, delta: "partial…" });
            opts.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      ],
    });
    const running = runAgentLoop(h.deps, { userMessage: { content: "hi" } });
    setTimeout(() => h.abort.abort(), 20);
    const result = await running;

    assert.equal(result.reason, "cancelled");
    // Decision 2026-07-11: nothing from the interrupted turn is persisted.
    assert.deepEqual(
      h.store.messages.map((m) => m.role),
      ["user"],
    );
  });

  test("stop mid server tool answers the in-flight AND queued calls as cancelled", async () => {
    const hang: AssistantTool = {
      name: "hang",
      description: "waits for abort",
      parameters: { type: "object", properties: {} },
      execution: "server",
      execute: (_input, ctx) =>
        new Promise((resolve) => ctx.signal.addEventListener("abort", () => resolve("late"), { once: true })),
    };
    const h = harness({
      turns: [{ text: "working", toolCalls: [call("c1", "hang"), call("c2", "hang")] }],
      tools: { hang },
      toolTimeoutMs: 5_000,
    });
    const running = runAgentLoop(h.deps, { userMessage: { content: "go" } });
    setTimeout(() => h.abort.abort(), 30);
    const result = await running;

    assert.equal(result.reason, "cancelled");
    const toolMsgs = h.store.messages.filter((m) => m.role === "tool");
    assert.equal(toolMsgs.length, 2);
    for (const t of toolMsgs) assert.equal(t.content, "Cancelled by user.");
    assertNoUnansweredCalls(h.store.messages);
    assert.equal(h.events.filter((e) => e.type === "tool_cancelled").length, 2);
  });

  test("stop before queued tool calls never starts them", async () => {
    let executions = 0;
    const tick: AssistantTool = {
      name: "tick",
      description: "counts",
      parameters: { type: "object", properties: {} },
      execution: "server",
      execute: async () => {
        executions++;
        h.abort.abort(); // user stops while the FIRST call is executing
        return "ticked";
      },
    };
    const h = harness({
      turns: [{ text: "", toolCalls: [call("c1", "tick"), call("c2", "tick"), call("c3", "tick")] }],
      tools: { tick },
    });
    const result = await runAgentLoop(h.deps, { userMessage: { content: "go" } });

    assert.equal(result.reason, "cancelled");
    assert.equal(executions, 1);
    const toolMsgs = h.store.messages.filter((m) => m.role === "tool");
    assert.equal(toolMsgs.length, 3); // every persisted call is answered
    assert.equal(toolMsgs[1].content, "Cancelled by user.");
    assert.equal(toolMsgs[2].content, "Cancelled by user.");
  });
});

test.describe("agent loop — tool failure is in-band", () => {
  test("a throwing server tool returns Error: … to the model and the run continues", async () => {
    const boom: AssistantTool = {
      name: "boom",
      description: "throws",
      parameters: { type: "object", properties: {} },
      execution: "server",
      execute: async () => {
        throw new Error("disk on fire");
      },
    };
    const h = harness({
      turns: [
        { text: "", toolCalls: [call("c1", "boom")] },
        { text: "recovered", toolCalls: [] },
      ],
      tools: { boom },
    });
    const result = await runAgentLoop(h.deps, { userMessage: { content: "go" } });
    assert.equal(result.reason, "completed");
    const toolMsg = h.store.messages.find((m) => m.role === "tool")!;
    assert.match(toolMsg.content!, /^Error: boom: disk on fire/);
  });

  test("a hanging server tool times out in-band (idle semantics)", async () => {
    const stuck: AssistantTool = {
      name: "stuck",
      description: "never settles",
      parameters: { type: "object", properties: {} },
      execution: "server",
      execute: () => new Promise(() => undefined),
    };
    const h = harness({
      turns: [
        { text: "", toolCalls: [call("c1", "stuck")] },
        { text: "moved on", toolCalls: [] },
      ],
      tools: { stuck },
      toolTimeoutMs: 40,
    });
    const result = await runAgentLoop(h.deps, { userMessage: { content: "go" } });
    assert.equal(result.reason, "completed");
    const toolMsg = h.store.messages.find((m) => m.role === "tool")!;
    assert.match(toolMsg.content!, /^Error: stuck: no result within/);
  });

  test("progress events push a streaming tool's idle deadline", async () => {
    const chatty: AssistantTool = {
      name: "chatty",
      description: "slow but talkative",
      parameters: { type: "object", properties: {} },
      execution: "server",
      execute: async (_input, ctx) => {
        for (let i = 0; i < 5; i++) {
          await new Promise((r) => setTimeout(r, 25));
          ctx.onEvent({ step: i });
        }
        return "finished slowly";
      },
    };
    const h = harness({
      turns: [
        { text: "", toolCalls: [call("c1", "chatty")] },
        { text: "ok", toolCalls: [] },
      ],
      tools: { chatty },
      toolTimeoutMs: 60, // < total runtime, > inter-event gap
    });
    const result = await runAgentLoop(h.deps, { userMessage: { content: "go" } });
    assert.equal(result.reason, "completed");
    assert.equal(h.store.messages.find((m) => m.role === "tool")!.content, "finished slowly");
    assert.equal(h.events.filter((e) => e.type === "tool_progress").length, 5);
  });

  test("a frontend tool with no client times out in-band and the run continues", async () => {
    const remote: AssistantTool = {
      name: "bos_app_launch",
      description: "frontend",
      parameters: { type: "object", properties: {} },
      execution: "frontend",
    };
    const h = harness({
      turns: [
        { text: "", toolCalls: [call("c1", "bos_app_launch")] },
        { text: "continued", toolCalls: [] },
      ],
      tools: { bos_app_launch: remote },
      frontend: async () => ({ kind: "timeout" }),
    });
    const result = await runAgentLoop(h.deps, { userMessage: { content: "go" } });
    assert.equal(result.reason, "completed");
    const toolMsg = h.store.messages.find((m) => m.role === "tool")!;
    assert.match(toolMsg.content!, /^Error: bos_app_launch: no client executed the tool/);
  });

  test("a frontend tool result is used verbatim", async () => {
    const remote: AssistantTool = {
      name: "web_view",
      description: "frontend",
      parameters: { type: "object", properties: {} },
      execution: "frontend",
    };
    const h = harness({
      turns: [
        { text: "", toolCalls: [call("c1", "web_view")] },
        { text: "ok", toolCalls: [] },
      ],
      tools: { web_view: remote },
      frontend: async () => ({ kind: "result", result: "opened the page" }),
    });
    const result = await runAgentLoop(h.deps, { userMessage: { content: "go" } });
    assert.equal(result.reason, "completed");
    assert.equal(h.store.messages.find((m) => m.role === "tool")!.content, "opened the page");
  });

  test("an unknown tool gets an in-band error", async () => {
    const h = harness({
      turns: [
        { text: "", toolCalls: [call("c1", "ghost_tool")] },
        { text: "ok", toolCalls: [] },
      ],
    });
    const result = await runAgentLoop(h.deps, { userMessage: { content: "go" } });
    assert.equal(result.reason, "completed");
    assert.match(h.store.messages.find((m) => m.role === "tool")!.content!, /^Error: ghost_tool: unknown tool/);
  });
});

test.describe("agent loop — leak retry", () => {
  test("retries a turn whose text contains leaked tool-call markup", async () => {
    const h = harness({
      turns: [
        { text: "<tool_call>{\"name\":\"x\"}</tool_call>", toolCalls: [] },
        { text: "clean answer", toolCalls: [] },
      ],
    });
    const result = await runAgentLoop(h.deps, { userMessage: { content: "go" } });
    assert.equal(result.reason, "completed");
    const assistants = h.store.messages.filter((m) => m.role === "assistant");
    assert.equal(assistants.length, 1);
    assert.equal(assistants[0].content, "clean answer");
  });

  test("persists the leaked turn once retries are exhausted", async () => {
    const leak = { text: "<tool_call>broken</tool_call>", toolCalls: [] };
    const h = harness({ turns: [leak, leak, leak] });
    const result = await runAgentLoop(h.deps, { userMessage: { content: "go" } });
    assert.equal(result.reason, "completed");
    const assistants = h.store.messages.filter((m) => m.role === "assistant");
    assert.equal(assistants.length, 1); // third attempt persisted as-is
  });
});

test.describe("agent loop — edit & resubmit", () => {
  const priorTranscript: ChatMessage[] = [
    { id: "u1", role: "user", content: "first question" },
    { id: "a1", role: "assistant", content: "first answer" },
    { id: "u2", role: "user", content: "flawed question" },
    { id: "a2", role: "assistant", content: "answer to flawed question" },
  ];

  test("truncates from the last user message and re-runs", async () => {
    const h = harness({
      turns: [{ text: "answer to fixed question", toolCalls: [] }],
      initial: priorTranscript,
    });
    const result = await runAgentLoop(h.deps, {
      userMessage: { content: "fixed question" },
      editOfMessageId: "u2",
    });
    assert.equal(result.reason, "completed");
    const contents = h.store.messages.map((m) => m.content);
    assert.deepEqual(contents, ["first question", "first answer", "fixed question", "answer to fixed question"]);
  });

  test("works when the edited message has NO agent response", async () => {
    const h = harness({
      turns: [{ text: "now it answers", toolCalls: [] }],
      initial: [{ id: "u1", role: "user", content: "unanswered" }],
    });
    const result = await runAgentLoop(h.deps, {
      userMessage: { content: "unanswered, edited" },
      editOfMessageId: "u1",
    });
    assert.equal(result.reason, "completed");
    assert.deepEqual(
      h.store.messages.map((m) => m.content),
      ["unanswered, edited", "now it answers"],
    );
  });

  test("rejects editing a message that is not the last user message", async () => {
    const h = harness({ turns: [], initial: priorTranscript });
    const result = await runAgentLoop(h.deps, {
      userMessage: { content: "nope" },
      editOfMessageId: "u1",
    });
    assert.equal(result.reason, "error");
    assert.match(result.error!, /not the last user message/);
    assert.equal(h.store.messages.length, priorTranscript.length); // untouched
  });
});

test.describe("agent loop — step limit", () => {
  test("closes the transcript in-band at max steps", async () => {
    const loopy: AssistantTool = {
      name: "again",
      description: "always called",
      parameters: { type: "object", properties: {} },
      execution: "server",
      execute: async () => "ok",
    };
    const h = harness({
      turns: [
        { text: "", toolCalls: [call("c1", "again")] },
        { text: "", toolCalls: [call("c2", "again")] },
      ],
      tools: { again: loopy },
      maxSteps: 2,
    });
    const result = await runAgentLoop(h.deps, { userMessage: { content: "go" } });
    assert.equal(result.reason, "max_steps");
    const last = h.store.messages[h.store.messages.length - 1];
    assert.equal(last.role, "assistant");
    assert.match(last.content!, /step limit/);
    assertNoUnansweredCalls(h.store.messages);
  });
});
