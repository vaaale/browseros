// Hand-run regression test for plan Risk 3 / plan-review P1, exercised END TO
// END through the REAL production call path (025-agent-delegation-v2, T052):
// a delegation tool (agent_delegate/dev_delegate's shape) run through the
// OUTER runAgentLoop's own runServerTool wrapper, whose inner loop is itself a
// SECOND runAgentLoop (via runInnerLoop). No test runner is wired into
// package.json — matches src/lib/agent/scratchpad/__tests__/handlers.test.ts.
//
// The risk: runServerTool's timeout races `tool.execute()` — it settles with
// an in-band error as soon as the timer fires, WITHOUT waiting for the tool's
// own promise. If the abort signal it fires (`callAbort`) didn't cascade all
// the way down through runInnerLoop's nested runAgentLoop (and ITS OWN nested
// runServerTool calls), the delegation would keep running "detached" after
// the parent already reported a timeout — making further tool calls / firing
// further onEvent callbacks nobody is listening for anymore.
//
// This test uses a deliberately UNCOOPERATIVE inner tool (ignores its own
// abort signal entirely, never settles on its own) specifically to prove the
// cascade works at the runServerTool/loop level, not merely because a
// well-behaved tool happened to listen for abort.

process.env.BOS_E2E_SCRIPTED = "1";

import { runAgentLoop, type AgentLoopDeps } from "../agent-loop";
import { runInnerLoop } from "../inner-loop";
import type { AssistantTool, ToolGateConfig, ToolContext } from "../tools";
import type { Run } from "../run-manager";
import { logger } from "@/lib/logging";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

function makeGate(allow: string[]): ToolGateConfig {
  return { allow: new Set(allow), deferred: new Set(), registryIds: new Set(allow), descriptions: {} };
}

function makeRun(overrides?: Partial<Run>): Run {
  return {
    id: "run-fake",
    conversationId: "conv-fake",
    agentId: "assistant",
    startedAt: Date.now(),
    status: "running",
    events: [],
    seq: 0,
    listeners: new Set(),
    abort: new AbortController(),
    pendingFrontend: new Map(),
    tools: {},
    // Deliberately large: proves the cascade (not the NESTED loop's own idle
    // timeout) is what stops the delegation.
    toolTimeoutMs: 10_000,
    agents: new Map(),
    ...overrides,
  };
}

function script(turns: unknown[]): string {
  return `@@e2e ${JSON.stringify({ turns })}`;
}

export async function testDelegationDoesNotContinueDetachedAfterOuterTimeout(): Promise<void> {
  // A nested tool that NEVER settles and never even looks at its own signal —
  // the strongest possible proof that something ABOVE it (not tool
  // cooperation) is what stops the delegation.
  let neverResolveCalls = 0;
  const neverResolveTool: AssistantTool = {
    name: "never_resolve_tool",
    description: "ignores its abort signal and never settles on its own",
    parameters: { type: "object", properties: {} },
    execution: "server",
    execute: () => {
      neverResolveCalls++;
      return new Promise(() => {
        /* deliberately never resolves/rejects */
      });
    },
  };

  const fakeRun = makeRun({ tools: { never_resolve_tool: neverResolveTool } });

  let delegateExecuteCalls = 0;
  const delegateTool: AssistantTool = {
    name: "delegate_tool",
    description: "shape of agent_delegate/dev_delegate: execute() runs a nested runAgentLoop via runInnerLoop",
    parameters: { type: "object", properties: {} },
    execution: "server",
    execute: async (_input, ctx: ToolContext) => {
      delegateExecuteCalls++;
      // Inner delegation script: a first step that hangs forever on
      // never_resolve_tool, then (if it were ever reached) a second step
      // that would prove "further tool calls" happened — it must NEVER be
      // reached if the abort cascade works.
      const innerTask = script([
        { text: "starting", tools: [{ name: "never_resolve_tool", args: {} }] },
        { text: "should never be reached" },
      ]);
      const result = await runInnerLoop(fakeRun, ctx, { systemPrompt: async () => "sys", gate: makeGate(["never_resolve_tool"]) }, innerTask, 5);
      return result.output || result.error || "(no output)";
    },
  };

  const events: { type: string }[] = [];
  const progressEvents: unknown[] = [];
  const emit: AgentLoopDeps["emit"] = (e) => {
    events.push(e);
    if (e.type === "tool_progress") progressEvents.push(e);
  };

  const svc = logger();
  const originalLog = svc.log.bind(svc);
  const captured: { component: string; conversation?: string; msg: string; data?: unknown }[] = [];
  svc.log = ((input: { component: string; conversation?: string; msg: string; data?: unknown }) => {
    captured.push(input);
  }) as typeof svc.log;

  try {
    let outerStreamCalls = 0;
    const startedAt = Date.now();
    const result = await runAgentLoop(
      {
        runId: "run-fake",
        conversationId: "conv-fake",
        agentId: "assistant",
        signal: new AbortController().signal,
        emit,
        streamTurn: async () => {
          outerStreamCalls++;
          if (outerStreamCalls === 1) return { text: "", toolCalls: [{ id: "call-1", name: "delegate_tool", arguments: "{}" }] };
          return { text: "done", toolCalls: [] };
        },
        composeSystem: async () => "system",
        tools: { delegate_tool: delegateTool },
        gate: makeGate(["delegate_tool"]),
        io: { loadMessages: async () => [], saveMessages: async () => {} },
        awaitFrontendResult: async () => ({ kind: "timeout" }),
        maxSteps: 4,
        // Short OUTER idle-timeout: this is what should fire and cascade an
        // abort all the way down through runInnerLoop's nested loop.
        toolTimeoutMs: 30,
      },
      { userMessage: { content: "go" } },
    );
    const elapsedMs = Date.now() - startedAt;

    assert(result.reason === "completed", `expected completed (a timed-out delegation is still an in-band result), got ${result.reason}`);
    assert(
      elapsedMs < 2_000,
      `expected the whole run to settle quickly (well under the nested run's own 10s toolTimeoutMs) — took ${elapsedMs}ms, suggesting the delegation kept running detached instead of being cancelled by the cascaded abort`,
    );
    assert(delegateExecuteCalls === 1, `expected delegate_tool.execute to run exactly once, ran ${delegateExecuteCalls} times`);
    assert(neverResolveCalls === 1, `expected the inner hanging tool to be called exactly once (no retry/second attempt), was called ${neverResolveCalls} times`);

    const progressCountAtSettle = progressEvents.length;
    assert(progressCountAtSettle === 1, `expected exactly ONE nested tool_progress event (the single never_resolve_tool call starting), got ${progressCountAtSettle}`);

    // The critical assertion: wait well past the point where a "detached"
    // continuation would have made further progress (started a second
    // scripted turn, forwarded another onEvent) if the abort cascade were
    // broken — confirm NOTHING further arrives.
    await new Promise((r) => setTimeout(r, 200));
    assert(
      progressEvents.length === progressCountAtSettle,
      `expected no further tool_progress events after the outer timeout settled — got ${progressEvents.length - progressCountAtSettle} more, meaning the delegation kept running detached`,
    );
    assert(neverResolveCalls === 1, `expected no further inner tool calls after the outer timeout settled, saw ${neverResolveCalls} total calls`);

    // Exactly one "server tool timed out" record — for the OUTER delegate_tool
    // call. If the nested loop's own (10s) idle-timeout had ALSO independently
    // fired (instead of being pre-empted by the cascaded abort), a second
    // record for never_resolve_tool would show up here too.
    const timeoutRecords = captured.filter((c) => c.component === "assistant.tools" && c.msg === "server tool timed out");
    assert(timeoutRecords.length === 1, `expected exactly one timeout log record, got ${timeoutRecords.length}: ${JSON.stringify(timeoutRecords)}`);
    assert((timeoutRecords[0].data as { tool?: string }).tool === "delegate_tool", `expected the timeout record to name delegate_tool, got ${JSON.stringify(timeoutRecords[0].data)}`);
    assert(timeoutRecords[0].conversation === "conv-fake", "expected a top-level conversation field so this is filterable in Settings -> Logs (T053)");
  } finally {
    svc.log = originalLog;
  }
}

export async function runAll(): Promise<void> {
  await testDelegationDoesNotContinueDetachedAfterOuterTimeout();
}
