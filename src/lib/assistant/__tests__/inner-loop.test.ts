// Hand-run unit tests for inner-loop.ts (025-agent-delegation-v2). No test
// runner is wired into package.json — matches
// src/lib/agent/scratchpad/__tests__/handlers.test.ts's convention.
// Uses the real scripted e2e provider (e2e-provider.ts) against BOS_E2E_SCRIPTED=1
// so this exercises the exact deterministic path the Playwright e2e suite relies on.

process.env.BOS_E2E_SCRIPTED = "1";

import { runInnerLoop, checkDelegationDepth, MAX_DELEGATE_DEPTH } from "../inner-loop";
import { STEP_LIMIT_TEXT } from "../agent-loop";
import type { Run } from "../run-manager";
import type { ToolGateConfig, ToolContext } from "../tools";
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
    toolTimeoutMs: 10_000,
    agents: new Map(),
    ...overrides,
  };
}

function makeCtx(overrides?: Partial<ToolContext>): { ctx: ToolContext; events: unknown[] } {
  const events: unknown[] = [];
  const ctx: ToolContext = {
    signal: new AbortController().signal,
    conversationId: "conv-fake",
    agentId: "assistant",
    runId: "run-fake",
    onEvent: (e) => events.push(e),
    ...overrides,
  };
  return { ctx, events };
}

function script(turns: unknown[]): string {
  return `@@e2e ${JSON.stringify({ turns })}`;
}

export async function testBlankSlateTaskSeeding(): Promise<void> {
  const run = makeRun();
  const { ctx } = makeCtx();
  const task = script([{ text: "Only what the task says." }]);
  const result = await runInnerLoop(run, ctx, { systemPrompt: async () => "sys", gate: makeGate([]) }, task, 4);
  assert(result.output === "Only what the task says.", `expected verbatim final answer, got: ${result.output}`);
  assert(result.steps === 1, `expected exactly 1 step for a single no-tool turn, got ${result.steps}`);
}

export async function testEventShapingReachesOnEvent(): Promise<void> {
  const run = makeRun();
  const { ctx, events } = makeCtx();
  const task = script([
    { text: "calling a tool", tools: [{ name: "memory_search", args: { query: "x" } }] },
    { text: "done" },
  ]);
  const result = await runInnerLoop(run, ctx, { systemPrompt: async () => "sys", gate: makeGate(["memory_search"]) }, task, 4);
  assert(result.output === "done", `expected final answer 'done', got: ${result.output}`);
  assert(events.length === 1, `expected exactly one shaped event, got ${events.length}`);
  const shaped = events[0] as { tool: string; input: unknown };
  assert(shaped.tool === "memory_search", `expected tool name memory_search, got ${shaped.tool}`);
  assert((shaped.input as { query?: string })?.query === "x", "expected parsed input.query === 'x'");
  assert(result.toolCalls.length === 1 && result.toolCalls[0].tool === "memory_search", "expected toolCalls to mirror the shaped event");
}

export async function testStepCapReturnsExactStepLimitText(): Promise<void> {
  const run = makeRun();
  const { ctx } = makeCtx();
  const maxSteps = 3;
  // More tool-call turns than maxSteps, never a final no-tool turn.
  const turns = Array.from({ length: maxSteps + 2 }, () => ({
    text: "still going",
    tools: [{ name: "memory_search", args: { query: "x" } }],
  }));
  const task = script(turns);
  const result = await runInnerLoop(run, ctx, { systemPrompt: async () => "sys", gate: makeGate(["memory_search"]) }, task, maxSteps);
  assert(result.output === STEP_LIMIT_TEXT(maxSteps), `expected the exact STEP_LIMIT_TEXT, got: ${result.output}`);
}

export async function testAbortSettlesAsCancelled(): Promise<void> {
  const run = makeRun();
  const callAbort = new AbortController();
  const { ctx } = makeCtx({ signal: callAbort.signal });
  // A turn with an artificial delay so there is time to abort mid-flight.
  const task = script([{ text: "slow turn", deltas: 4, delayMs: 40 }, { text: "unreachable" }]);
  const donePromise = runInnerLoop(run, ctx, { systemPrompt: async () => "sys", gate: makeGate([]) }, task, 4);
  setTimeout(() => callAbort.abort(), 15);
  const result = await donePromise;
  assert(result.output === "Delegation cancelled.", `expected cancellation string, got: ${result.output}`);
}

export async function testDepthGuardRejectsAtBoundaryAndLogs(): Promise<void> {
  const svc = logger();
  const originalLog = svc.log.bind(svc);
  const captured: { component: string; conversation?: string; msg: string; data?: unknown }[] = [];
  svc.log = ((input: { component: string; conversation?: string; msg: string; data?: unknown }) => {
    captured.push(input);
  }) as typeof svc.log;
  try {
    const belowLimit = checkDelegationDepth({ conversationId: "c", agentId: "a", delegationDepth: MAX_DELEGATE_DEPTH - 1 });
    assert(belowLimit.ok === true, "one below the limit should be allowed");

    const atLimit = checkDelegationDepth({ conversationId: "c", agentId: "a", delegationDepth: MAX_DELEGATE_DEPTH });
    assert(atLimit.ok === false, "at the limit should be rejected");
    if (!atLimit.ok) {
      assert(atLimit.error === "Delegation depth limit reached; cannot nest another delegation.", `unexpected error text: ${atLimit.error}`);
    }

    const rec = captured.find((c) => c.component === "assistant.delegate" && c.msg === "delegation depth limit reached");
    assert(rec, "expected a depth-limit-reached log record");
    assert(rec!.conversation === "c", "expected a top-level conversation field so this is filterable in Settings -> Logs (T053)");
    const data = rec!.data as { depth?: number };
    assert(data.depth === MAX_DELEGATE_DEPTH, `expected depth ${MAX_DELEGATE_DEPTH} in the log record, got ${data.depth}`);
  } finally {
    svc.log = originalLog;
  }
}

export async function runAll(): Promise<void> {
  await testBlankSlateTaskSeeding();
  await testEventShapingReachesOnEvent();
  await testStepCapReturnsExactStepLimitText();
  await testAbortSettlesAsCancelled();
  await testDepthGuardRejectsAtBoundaryAndLogs();
}
