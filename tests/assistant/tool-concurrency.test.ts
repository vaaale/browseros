// Parallel tool execution in the agent loop (opt-in via AssistantTool.parallelSafe):
//   npx playwright test -c playwright.unit.config.ts tests/assistant/tool-concurrency.test.ts
//
// The invariants that matter here are the ones a concurrency bug would break
// silently: every tool_use id still gets an answer, the transcript order still
// matches CALL order (not completion order), and a non-parallel-safe tool is
// still strictly serialized against its neighbours.

import { test } from "@playwright/test";
import { strict as assert } from "node:assert";

import {
  runAgentLoop,
  batchToolCalls,
  type AgentLoopDeps,
  type StreamTurn,
  type TurnResult,
  type TurnToolCall,
} from "../../src/lib/assistant/agent-loop";
import type { ChatMessage } from "../../src/lib/assistant/messages";
import type { RunEventInput } from "../../src/lib/assistant/run-events";
import type { AssistantTool, ToolGateConfig } from "../../src/lib/assistant/tools";
import type { FrontendOutcome } from "../../src/lib/assistant/run-manager";

function scriptedProvider(turns: TurnResult[]): StreamTurn {
  let i = 0;
  return async () => {
    const turn = turns[i++];
    if (!turn) throw new Error(`scripted provider exhausted at turn ${i}`);
    return turn;
  };
}

function openGate(): ToolGateConfig {
  return { allow: new Set(), deferred: new Set(), registryIds: new Set(), descriptions: {} };
}

function harness(opts: { turns: TurnResult[]; tools: Record<string, AssistantTool>; maxParallelTools?: number }) {
  const store = { messages: [] as ChatMessage[] };
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
    tools: opts.tools,
    gate: openGate(),
    io: {
      loadMessages: async () => [...store.messages],
      saveMessages: async (m) => {
        store.messages = [...m];
      },
    },
    awaitFrontendResult: async () => ({ kind: "timeout" }),
    maxSteps: 8,
    toolTimeoutMs: 2000,
    ...(opts.maxParallelTools !== undefined ? { maxParallelTools: opts.maxParallelTools } : {}),
  };
  return { deps, store, events, abort };
}

const call = (id: string, name: string): TurnToolCall => ({ id, name, arguments: "{}" });

/** A tool that records overlap: how many copies of it were running at once. */
function trackingTool(
  name: string,
  opts: { parallelSafe: boolean; delayMs: number; tracker: { inFlight: number; peak: number; order: string[] } },
): AssistantTool {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    execution: "server",
    parallelSafe: opts.parallelSafe,
    execute: async () => {
      opts.tracker.inFlight++;
      opts.tracker.peak = Math.max(opts.tracker.peak, opts.tracker.inFlight);
      await new Promise((r) => setTimeout(r, opts.delayMs));
      opts.tracker.inFlight--;
      opts.tracker.order.push(name);
      return `${name}:done`;
    },
  };
}

test.describe("batchToolCalls — grouping", () => {
  const safe: AssistantTool = {
    name: "safe",
    description: "",
    parameters: {},
    execution: "server",
    parallelSafe: true,
    execute: async () => "",
  };
  const unsafe: AssistantTool = {
    name: "unsafe",
    description: "",
    parameters: {},
    execution: "server",
    execute: async () => "",
  };
  const tools = { safe, unsafe };

  test("groups adjacent parallel-safe calls and isolates unsafe ones", () => {
    const calls = [call("1", "safe"), call("2", "safe"), call("3", "unsafe"), call("4", "safe")];
    const batches = batchToolCalls(calls, tools, 6).map((b) => b.map((c) => c.id));
    // The two leading reads overlap; the write is alone; the trailing read is
    // alone because it comes AFTER the write — order is never rearranged.
    assert.deepEqual(batches, [["1", "2"], ["3"], ["4"]]);
  });

  test("respects the concurrency cap", () => {
    const calls = ["1", "2", "3", "4", "5"].map((id) => call(id, "safe"));
    const batches = batchToolCalls(calls, tools, 2).map((b) => b.map((c) => c.id));
    assert.deepEqual(batches, [["1", "2"], ["3", "4"], ["5"]]);
  });

  test("an unknown tool is never batched (stays sequential)", () => {
    const calls = [call("1", "safe"), call("2", "nope"), call("3", "safe")];
    const batches = batchToolCalls(calls, tools, 6).map((b) => b.map((c) => c.id));
    assert.deepEqual(batches, [["1"], ["2"], ["3"]]);
  });

  test("a cap below 1 is clamped, never producing empty or dropped batches", () => {
    const calls = [call("1", "safe"), call("2", "safe")];
    const batches = batchToolCalls(calls, tools, 0).map((b) => b.map((c) => c.id));
    assert.deepEqual(batches, [["1"], ["2"]]);
  });
});

test.describe("agent loop — parallel execution", () => {
  test("parallel-safe calls actually overlap", async () => {
    const tracker = { inFlight: 0, peak: 0, order: [] as string[] };
    const fetchA = trackingTool("fetch_a", { parallelSafe: true, delayMs: 40, tracker });
    const h = harness({
      turns: [
        { text: "", toolCalls: [call("c1", "fetch_a"), call("c2", "fetch_a"), call("c3", "fetch_a")] },
        { text: "done", toolCalls: [] },
      ],
      tools: { fetch_a: fetchA },
    });
    const started = Date.now();
    const result = await runAgentLoop(h.deps, { userMessage: { content: "go" } });
    const elapsed = Date.now() - started;

    assert.equal(result.reason, "completed");
    assert.equal(tracker.peak, 3, "all three should have been in flight together");
    // 3 × 40ms serialized would be ≥120ms; concurrent should be far under.
    assert.ok(elapsed < 110, `expected concurrent execution, took ${elapsed}ms`);
  });

  test("a non-parallel-safe tool never overlaps anything", async () => {
    const tracker = { inFlight: 0, peak: 0, order: [] as string[] };
    const write = trackingTool("write", { parallelSafe: false, delayMs: 20, tracker });
    const read = trackingTool("read", { parallelSafe: true, delayMs: 20, tracker });
    const h = harness({
      turns: [
        { text: "", toolCalls: [call("c1", "read"), call("c2", "write"), call("c3", "read")] },
        { text: "done", toolCalls: [] },
      ],
      tools: { write, read },
    });
    await runAgentLoop(h.deps, { userMessage: { content: "go" } });

    // read(alone) → write(alone) → read(alone): nothing ever overlaps, because
    // the safe reads are not ADJACENT to each other.
    assert.equal(tracker.peak, 1);
    assert.deepEqual(tracker.order, ["read", "write", "read"]);
  });

  test("transcript order follows CALL order, not completion order", async () => {
    // slow_first finishes last, but must still appear first in the transcript.
    const mk = (name: string, delayMs: number): AssistantTool => ({
      name,
      description: "",
      parameters: {},
      execution: "server",
      parallelSafe: true,
      execute: async () => {
        await new Promise((r) => setTimeout(r, delayMs));
        return `${name}:done`;
      },
    });
    const h = harness({
      turns: [
        { text: "", toolCalls: [call("c1", "slow"), call("c2", "fast")] },
        { text: "done", toolCalls: [] },
      ],
      tools: { slow: mk("slow", 60), fast: mk("fast", 5) },
    });
    await runAgentLoop(h.deps, { userMessage: { content: "go" } });

    const toolMsgs = h.store.messages.filter((m) => m.role === "tool");
    assert.deepEqual(
      toolMsgs.map((m) => m.toolCallId),
      ["c1", "c2"],
      "results must be appended in call order even though c2 finished first",
    );
    assert.equal(toolMsgs[0].content, "slow:done");
    assert.equal(toolMsgs[1].content, "fast:done");
  });

  test("every call is answered even when one throws", async () => {
    const ok: AssistantTool = {
      name: "ok",
      description: "",
      parameters: {},
      execution: "server",
      parallelSafe: true,
      execute: async () => "fine",
    };
    const boom: AssistantTool = {
      name: "boom",
      description: "",
      parameters: {},
      execution: "server",
      parallelSafe: true,
      execute: async () => {
        throw new Error("kaboom");
      },
    };
    const h = harness({
      turns: [
        { text: "", toolCalls: [call("c1", "ok"), call("c2", "boom"), call("c3", "ok")] },
        { text: "done", toolCalls: [] },
      ],
      tools: { ok, boom },
    });
    const result = await runAgentLoop(h.deps, { userMessage: { content: "go" } });

    assert.equal(result.reason, "completed");
    const answered = h.store.messages.filter((m) => m.role === "tool").map((m) => m.toolCallId);
    assert.deepEqual(answered, ["c1", "c2", "c3"], "a throwing tool must not strand its siblings");
    const failed = h.store.messages.find((m) => m.toolCallId === "c2");
    assert.ok(failed?.content?.startsWith("Error: boom:"), `got: ${failed?.content}`);
  });

  test("cancelling mid-batch still answers every queued call", async () => {
    const tracker = { inFlight: 0, peak: 0, order: [] as string[] };
    const slow = trackingTool("slow", { parallelSafe: true, delayMs: 1000, tracker });
    const h = harness({
      turns: [
        { text: "", toolCalls: [call("c1", "slow"), call("c2", "slow"), call("c3", "slow")] },
        { text: "done", toolCalls: [] },
      ],
      tools: { slow },
      maxParallelTools: 2, // c1+c2 in flight, c3 queued behind them
    });
    const run = runAgentLoop(h.deps, { userMessage: { content: "go" } });
    setTimeout(() => h.abort.abort(), 30);
    const result = await run;

    assert.equal(result.reason, "cancelled");
    const answered = h.store.messages.filter((m) => m.role === "tool").map((m) => m.toolCallId);
    assert.deepEqual(answered, ["c1", "c2", "c3"], "in-flight AND queued calls must all be answered");
  });

  test("frontend tools batch too: all dispatched before any resolves", async () => {
    // The whole point of announcing a batch up front is that the browser can
    // execute several frontend tools at once. Model the client: record when
    // each callId is dispatched, then resolve them out of order.
    const dispatched: string[] = [];
    const pending = new Map<string, (r: FrontendOutcome) => void>();
    const clickish: AssistantTool = {
      name: "read_ui",
      description: "",
      parameters: {},
      execution: "frontend",
      parallelSafe: true,
    };
    const h = harness({
      turns: [
        { text: "", toolCalls: [call("c1", "read_ui"), call("c2", "read_ui")] },
        { text: "done", toolCalls: [] },
      ],
      tools: { read_ui: clickish },
    });
    h.deps.awaitFrontendResult = (callId) =>
      new Promise<FrontendOutcome>((resolve) => {
        dispatched.push(callId);
        pending.set(callId, resolve);
        // Once BOTH are dispatched, answer them in REVERSE order.
        if (pending.size === 2) {
          setTimeout(() => {
            pending.get("c2")!({ kind: "result", result: "second" });
            pending.get("c1")!({ kind: "result", result: "first" });
          }, 5);
        }
      });

    await runAgentLoop(h.deps, { userMessage: { content: "go" } });

    assert.deepEqual(dispatched, ["c1", "c2"], "both frontend calls must be in flight together");
    const toolMsgs = h.store.messages.filter((m) => m.role === "tool");
    assert.deepEqual(
      toolMsgs.map((m) => [m.toolCallId, m.content]),
      [
        ["c1", "first"],
        ["c2", "second"],
      ],
      "answered out of order, but the transcript must still be in call order",
    );
  });

  test("tool_call events for a batch are emitted before any of them resolve", async () => {
    const t = trackingTool("t", {
      parallelSafe: true,
      delayMs: 30,
      tracker: { inFlight: 0, peak: 0, order: [] },
    });
    const h = harness({
      turns: [
        { text: "", toolCalls: [call("c1", "t"), call("c2", "t")] },
        { text: "done", toolCalls: [] },
      ],
      tools: { t },
    });
    await runAgentLoop(h.deps, { userMessage: { content: "go" } });

    const seq = h.events.filter((e) => e.type === "tool_call" || e.type === "tool_result").map((e) => e.type);
    // Both announcements land before the first result — that's what lets the
    // browser dispatch frontend tools in a batch concurrently.
    assert.deepEqual(seq, ["tool_call", "tool_call", "tool_result", "tool_result"]);
  });
});
