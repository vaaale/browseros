// Hand-run unit tests for agent-loop.ts's runServerTool timeout / linked-abort
// behavior (025-agent-delegation-v2, plan-review P1/Risk 3). No test runner is
// wired into package.json — matches src/lib/agent/scratchpad/__tests__/handlers.test.ts.
// Exercises a NON-delegation tool specifically, since the linked-abort
// AbortController construction now affects every server tool call, not just
// agent_delegate/dev_delegate.

import { runAgentLoop, type AgentLoopDeps } from "../agent-loop";
import type { AssistantTool, ToolGateConfig } from "../tools";
import { logger } from "@/lib/logging";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

function makeGate(allow: string[]): ToolGateConfig {
  return { allow: new Set(allow), deferred: new Set(), registryIds: new Set(allow), descriptions: {} };
}

function makeIO(): { io: AgentLoopDeps["io"] } {
  return {
    io: {
      loadMessages: async () => [],
      saveMessages: async () => {
        /* this test only cares about tool-timeout/abort behavior, not the transcript */
      },
    },
  };
}

export async function testHangingToolTimesOutAbortsSignalAndLogs(): Promise<void> {
  let sawAbort = false;
  const hangingTool: AssistantTool = {
    name: "hang_tool",
    description: "a tool whose execute() never resolves on its own",
    parameters: { type: "object", properties: {} },
    execution: "server",
    execute: (_input, ctx) =>
      new Promise((resolve) => {
        ctx.signal.addEventListener("abort", () => {
          sawAbort = true;
          resolve("(aborted, never actually used)");
        });
      }),
  };

  const svc = logger();
  const originalLog = svc.log.bind(svc);
  const captured: { component: string; conversation?: string; msg: string; data?: unknown }[] = [];
  svc.log = ((input: { component: string; conversation?: string; msg: string; data?: unknown }) => {
    captured.push(input);
  }) as typeof svc.log;

  try {
    const { io } = makeIO();
    let calls = 0;
    const result = await runAgentLoop(
      {
        runId: "r-test",
        conversationId: "c-test",
        agentId: "a-test",
        signal: new AbortController().signal,
        emit: () => {},
        streamTurn: async () => {
          calls++;
          if (calls === 1) return { text: "", toolCalls: [{ id: "call-1", name: "hang_tool", arguments: "{}" }] };
          return { text: "done", toolCalls: [] };
        },
        composeSystem: async () => "system",
        tools: { hang_tool: hangingTool },
        gate: makeGate(["hang_tool"]),
        io,
        awaitFrontendResult: async () => ({ kind: "timeout" }),
        maxSteps: 4,
        toolTimeoutMs: 30,
      },
      { userMessage: { content: "go" } },
    );

    assert(result.reason === "completed", `expected completed (a timed-out tool is still an in-band result, not a run error), got ${result.reason}`);

    // The hanging tool's abort listener runs asynchronously off the timer
    // callback; give it a tick to observe the signal.
    await new Promise((r) => setTimeout(r, 20));
    assert(sawAbort, "ctx.signal passed to a timed-out tool's execute() must abort (plan-review P1 linked-abort fix)");

    const rec = captured.find((c) => c.component === "assistant.tools");
    assert(rec, "expected an assistant.tools log record for the timed-out tool call");
    assert(rec!.msg === "server tool timed out", `unexpected log message: ${rec!.msg}`);
    assert(rec!.conversation === "c-test", "expected a top-level conversation field so this is filterable in Settings -> Logs (T053)");
    const data = rec!.data as { conversationId?: string; agentId?: string; tool?: string; timeoutMs?: number };
    assert(data.conversationId === "c-test", "expected conversationId in the log record");
    assert(data.agentId === "a-test", "expected agentId in the log record");
    assert(data.tool === "hang_tool", "expected tool name in the log record");
    assert(data.timeoutMs === 30, "expected timeoutMs in the log record");
  } finally {
    svc.log = originalLog;
  }
}

export async function runAll(): Promise<void> {
  await testHangingToolTimesOutAbortsSignalAndLogs();
}
