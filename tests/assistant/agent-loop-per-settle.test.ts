// 045-chat-live-tool (US1, T004 unit leg): the run loop emits each parallel-safe
// call's tool_result AS IT SETTLES (completion order), while persistence stays in
// ORIGINAL call order. Before this feature the two were fused in one trailing loop,
// so every tool_result fired in a single burst after the SLOWEST call, in original
// order — fast calls sat "running" in the UI until the whole batch landed.
//
// These are the precise, deterministic invariants the e2e (e2e/045-chat-live-tool.
// spec.ts) can only observe weakly through the DOM:
//   FR-001  a faster call's tool_result is emitted before a slower call settles
//   FR-002  the persisted transcript is in original call order, not completion order
//   SC-002  two runs of identical input → identical persisted order
//   FR-004  a cancelled call emits tool_cancelled exactly once, promptly
//   FR-008  an erroring call emits its own result and does not hold its siblings
//   (edge)  a non-parallel-safe call is never batched and is unchanged
//   npm run test:unit -- tests/assistant/agent-loop-per-settle.test.ts

import { test, expect } from "@playwright/test";
import {
  runAgentLoop,
  type AgentLoopDeps,
  type StreamTurn,
  type TurnResult,
} from "../../src/lib/assistant/agent-loop";
import type { ChatMessage } from "../../src/lib/assistant/messages";
import type { RunEventInput } from "../../src/lib/assistant/run-events";
import type { AssistantTool, ToolGateConfig } from "../../src/lib/assistant/tools";
import type { FrontendOutcome } from "../../src/lib/assistant/run-manager";

function openGate(): ToolGateConfig {
  return { allow: new Set(), deferred: new Set(), registryIds: new Set(), descriptions: {} };
}

const call = (id: string, name: string): { id: string; name: string; arguments: string } => ({
  id,
  name,
  arguments: "{}",
});

interface Clock {
  // When each tool's execute() RESOLVED (server-side settle), by call name.
  settledAt: Record<string, number>;
  // When each tool_result run-event was EMITTED, by callId.
  emittedAt: Record<string, number>;
}

interface Harness {
  deps: AgentLoopDeps;
  store: { messages: ChatMessage[] };
  events: RunEventInput[];
  abort: AbortController;
  clock: Clock;
}

function harness(opts: {
  turns: TurnResult[];
  tools: Record<string, AssistantTool>;
  clock: Clock;
  maxSteps?: number;
  toolTimeoutMs?: number;
}): Harness {
  const store = { messages: [] as ChatMessage[] };
  const events: RunEventInput[] = [];
  const abort = new AbortController();
  const clock = opts.clock;
  let i = 0;
  const streamTurn: StreamTurn = async () => {
    const turn = opts.turns[i++];
    if (!turn) throw new Error(`scripted provider exhausted at turn ${i}`);
    return turn;
  };
  const deps: AgentLoopDeps = {
    runId: "run-test",
    conversationId: "c-test",
    agentId: "default_agent",
    signal: abort.signal,
    emit: (e) => {
      if (e.type === "tool_result") clock.emittedAt[e.callId] = Date.now();
      events.push(e);
    },
    streamTurn,
    composeSystem: async () => "system prompt",
    tools: opts.tools,
    gate: openGate(),
    io: {
      loadMessages: async () => [...store.messages],
      saveMessages: async (m) => {
        store.messages = [...m];
      },
    },
    awaitFrontendResult: async () => ({ kind: "timeout" } as FrontendOutcome),
    maxSteps: opts.maxSteps ?? 8,
    toolTimeoutMs: opts.toolTimeoutMs ?? 5000,
  };
  return { deps, store, events, abort, clock };
}

// A parallel-safe tool that records its server-side settle time and returns a
// deterministic result. `delayMs` staggers completion.
function delayTool(name: string, delayMs: number, clock: Clock): AssistantTool {
  return {
    name,
    description: "",
    parameters: {},
    execution: "server",
    parallelSafe: true,
    execute: async () => {
      await new Promise((r) => setTimeout(r, delayMs));
      clock.settledAt[name] = Date.now();
      return `${name}:done`;
    },
  };
}

function terminalEventIndex(events: RunEventInput[], callId: string): number {
  return events.findIndex((e) => e.callId === callId && (e.type === "tool_result" || e.type === "tool_cancelled"));
}

test.describe("US1 — per-settle emission, original-order persistence", () => {
  test("a faster call's tool_result is emitted before the slower call even settles (FR-001)", async () => {
    const clock: Clock = { settledAt: {}, emittedAt: {} };
    const h = harness({
      clock,
      // A is slow (first in the turn), B is fast (second). They batch together.
      turns: [
        { text: "", toolCalls: [call("cA", "slow"), call("cB", "fast")] },
        { text: "done", toolCalls: [] },
      ],
      tools: {
        slow: delayTool("slow", 120, clock),
        fast: delayTool("fast", 15, clock),
      },
    });
    const result = await runAgentLoop(h.deps, { userMessage: { content: "go" } });
    expect(result.reason).toBe("completed");

    // Completion order drives the LIVE stream: the fast call's tool_result is
    // emitted before the slow call has even settled — it is NOT held for the batch.
    expect(clock.emittedAt.cB).toBeLessThan(clock.settledAt.slow);
    // And the fast result is emitted before the slow result in event order.
    expect(terminalEventIndex(h.events, "cB")).toBeLessThan(terminalEventIndex(h.events, "cA"));
  });

  test("the persisted transcript stays in ORIGINAL call order regardless of completion order (FR-002)", async () => {
    const clock: Clock = { settledAt: {}, emittedAt: {} };
    const h = harness({
      clock,
      turns: [
        { text: "", toolCalls: [call("cA", "slow"), call("cB", "fast")] },
        { text: "done", toolCalls: [] },
      ],
      tools: {
        slow: delayTool("slow", 120, clock),
        fast: delayTool("fast", 15, clock),
      },
    });
    await runAgentLoop(h.deps, { userMessage: { content: "go" } });

    const toolMsgs = h.store.messages.filter((m) => m.role === "tool");
    // cA was issued first, so its tool message is persisted first — even though
    // cB (fast) completed first.
    expect(toolMsgs.map((m) => m.toolCallId)).toEqual(["cA", "cB"]);
    expect(toolMsgs[0].content).toBe("slow:done");
    expect(toolMsgs[1].content).toBe("fast:done");

    // The message events (which drive reload order) are also in original order.
    const msgEvents = h.events
      .filter((e) => e.type === "message" && e.message.role === "tool")
      .map((e) => e.message.toolCallId);
    expect(msgEvents).toEqual(["cA", "cB"]);
  });

  test("two runs of identical input yield identical persisted order (SC-002)", async () => {
    const run = async (): Promise<string[]> => {
      const clock: Clock = { settledAt: {}, emittedAt: {} };
      const h = harness({
        clock,
        turns: [
          { text: "", toolCalls: [call("cA", "slow"), call("cB", "fast"), call("cC", "fast")] },
          { text: "done", toolCalls: [] },
        ],
        tools: {
          slow: delayTool("slow", 90, clock),
          fast: delayTool("fast", 10, clock),
        },
      });
      await runAgentLoop(h.deps, { userMessage: { content: "go" } });
      return h.store.messages.filter((m) => m.role === "tool").map((m) => m.toolCallId);
    };
    // cC and cB are equally fast; their relative completion order is racy, but the
    // PERSISTED order must be stable regardless.
    expect(await run()).toEqual(["cA", "cB", "cC"]);
    expect(await run()).toEqual(["cA", "cB", "cC"]);
  });

  test("an erroring call emits its own result and does not hold its FAST siblings (FR-008)", async () => {
    const clock: Clock = { settledAt: {}, emittedAt: {} };
    // boom is the SLOW call and it errors; fast settles long before boom does.
    const boom: AssistantTool = {
      name: "boom",
      description: "",
      parameters: {},
      execution: "server",
      parallelSafe: true,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 120));
        clock.settledAt.boom = Date.now();
        throw new Error("kaboom");
      },
    };
    const h = harness({
      clock,
      turns: [
        { text: "", toolCalls: [call("cBoom", "boom"), call("cFast", "fast")] },
        { text: "done", toolCalls: [] },
      ],
      tools: { boom, fast: delayTool("fast", 15, clock) },
    });
    const result = await runAgentLoop(h.deps, { userMessage: { content: "go" } });
    expect(result.reason).toBe("completed");

    // The error settles in-band and is emitted individually…
    const boomResult = h.events.find((e) => e.type === "tool_result" && e.callId === "cBoom");
    expect(boomResult).toBeTruthy();
    expect((boomResult as { result: string }).result).toMatch(/^Error: boom: kaboom/);
    // …and the FAST sibling's result is emitted at ITS settle — before the slow
    // error has even settled — i.e. the error does not hold its siblings' emissions.
    expect(clock.emittedAt.cFast).toBeLessThan(clock.settledAt.boom);
    // Persisted in original order.
    expect(h.store.messages.filter((m) => m.role === "tool").map((m) => m.toolCallId)).toEqual(["cBoom", "cFast"]);
  });

  test("cancelling mid-batch emits tool_cancelled exactly once per still-running call, promptly (FR-004)", async () => {
    const hang: AssistantTool = {
      name: "hang",
      description: "",
      parameters: {},
      execution: "server",
      parallelSafe: true,
      execute: (_input, ctx) =>
        new Promise((resolve) => ctx.signal.addEventListener("abort", () => resolve("late"), { once: true })),
    };
    const h = harness({
      clock: { settledAt: {}, emittedAt: {} },
      turns: [{ text: "working", toolCalls: [call("c1", "hang"), call("c2", "hang")] }],
      tools: { hang },
      toolTimeoutMs: 10_000,
    });
    const run = runAgentLoop(h.deps, { userMessage: { content: "go" } });
    setTimeout(() => h.abort.abort(), 40);
    const result = await run;
    expect(result.reason).toBe("cancelled");

    // Exactly ONE tool_cancelled per call — the de-dup rule (ADR-1 / S2): the
    // settle-time emission is the single terminal authority; the trailing loop
    // persists but does not re-emit.
    expect(h.events.filter((e) => e.type === "tool_cancelled" && e.callId === "c1")).toHaveLength(1);
    expect(h.events.filter((e) => e.type === "tool_cancelled" && e.callId === "c2")).toHaveLength(1);
    // No tool_result for a cancelled call (exactly one terminal event per call).
    expect(h.events.filter((e) => e.type === "tool_result")).toHaveLength(0);
    // The cancelled calls are still persisted (the transcript stays settled).
    const toolMsgs = h.store.messages.filter((m) => m.role === "tool");
    expect(toolMsgs.map((m) => m.toolCallId)).toEqual(["c1", "c2"]);
    for (const t of toolMsgs) expect(t.content).toBe("Cancelled by user.");
  });

  test("a non-parallel-safe call is never batched and completes individually, unchanged (edge)", async () => {
    const clock: Clock = { settledAt: {}, emittedAt: {} };
    const write: AssistantTool = {
      name: "write",
      description: "",
      parameters: {},
      execution: "server",
      // NOT parallelSafe.
      execute: async () => {
        await new Promise((r) => setTimeout(r, 30));
        clock.settledAt.write = Date.now();
        return "wrote";
      },
    };
    const h = harness({
      clock,
      turns: [
        { text: "", toolCalls: [call("cW", "write"), call("cF", "fast")] },
        { text: "done", toolCalls: [] },
      ],
      tools: { write, fast: delayTool("fast", 10, clock) },
    });
    await runAgentLoop(h.deps, { userMessage: { content: "go" } });

    // write (not parallel-safe) runs strictly before fast (its batch is [write],[fast]).
    expect(terminalEventIndex(h.events, "cW")).toBeLessThan(terminalEventIndex(h.events, "cF"));
    expect(h.store.messages.filter((m) => m.role === "tool").map((m) => m.toolCallId)).toEqual(["cW", "cF"]);
  });

  test("a single-call parallel batch degrades to current behavior (edge)", async () => {
    const clock: Clock = { settledAt: {}, emittedAt: {} };
    const h = harness({
      clock,
      turns: [
        { text: "", toolCalls: [call("c1", "solo")] },
        { text: "done", toolCalls: [] },
      ],
      tools: { solo: delayTool("solo", 20, clock) },
    });
    const result = await runAgentLoop(h.deps, { userMessage: { content: "go" } });
    expect(result.reason).toBe("completed");
    const solo = h.events.find((e) => e.type === "tool_result" && e.callId === "c1");
    expect(solo).toBeTruthy();
    expect((solo as { result: string }).result).toBe("solo:done");
    expect(h.store.messages.filter((m) => m.role === "tool")).toHaveLength(1);
  });
});
