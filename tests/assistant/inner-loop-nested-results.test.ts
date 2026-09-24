// 045-chat-live-tool (US2, T006 unit leg): a delegation's inner loop must
// forward each nested tool RESULT (and cancellation) live through the per-call
// tool_progress channel (ToolContext.onEvent) — not only nested tool STARTS as
// today — and must return the full per-child terminal result list on
// InnerLoopResult so delegate-local can encode it (ADR-3 / B1). Before this
// feature the inner loop swallowed server-exec nested tool_results (they were
// only forwarded for frontend-exec calls) and returned only the starts.
//
// Drives the REAL runInnerLoop with the scripted e2e provider (BOS_E2E_SCRIPTED=1),
// the same deterministic path the Playwright e2e (e2e/045-chat-live-tool.spec.ts)
// relies on.
//   npm run test:unit -- tests/assistant/inner-loop-nested-results.test.ts

import { test, expect } from "@playwright/test";

process.env.BOS_E2E_SCRIPTED = "1";

import { runInnerLoop } from "../../src/lib/assistant/inner-loop";
import type { Run } from "../../src/lib/assistant/run-manager";
import type { ToolGateConfig, ToolContext, AssistantTool } from "../../src/lib/assistant/tools";
import { encodeNested } from "../../src/lib/agent/nested-events";

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

const script = (turns: unknown[]) => `@@e2e ${JSON.stringify({ turns })}`;

const memorySearch: AssistantTool = {
  name: "memory_search",
  description: "",
  parameters: {},
  execution: "server",
  execute: async (input) => `found:${String(input.query)}`,
};

// A "delegation-shaped" server tool that RETURNS an encodeNested envelope, so we
// can verify the inner loop resolves a child's own nested list from its result.
const fakeDelegate: AssistantTool = {
  name: "fake_delegate",
  description: "",
  parameters: {},
  execution: "server",
  execute: async () =>
    "summary" + encodeNested({ events: [{ tool: "docs_read", input: { ref: "r" }, result: "doc body", status: "done" }], output: "inner out" }),
};

test("a nested server-tool result is forwarded live (not only the start) and returned on InnerLoopResult (FR-005)", async () => {
  const run = makeRun({ tools: { memory_search: memorySearch } });
  const { ctx, events } = makeCtx();
  const task = script([
    { text: "searching", tools: [{ name: "memory_search", args: { query: "x" } }] },
    { text: "done" },
  ]);
  const result = await runInnerLoop(run, ctx, { systemPrompt: async () => "sys", gate: makeGate(["memory_search"]) }, task, 4);

  expect(result.output).toBe("done");

  // The parent card's live progress must contain a START and, NEW, a RESULT entry.
  const start = events.find((e) => (e as { tool?: string; type?: string }).tool === "memory_search" && !(e as { type?: string }).type);
  expect(start, "a nested start entry is still forwarded").toBeTruthy();
  const res = events.find((e) => (e as { tool?: string; type?: string }).type === "tool_result" && (e as { tool?: string }).tool === "memory_search");
  expect(res, "the nested tool_result is forwarded live through ctx.onEvent").toBeTruthy();
  expect((res as { result: string }).result).toBe("found:x");

  // InnerLoopResult carries the per-child terminal list (B1) with result + status.
  expect(result.results).toHaveLength(1);
  expect(result.results[0].tool).toBe("memory_search");
  expect(result.results[0].result).toBe("found:x");
  expect(result.results[0].status).toBe("done");
});

test("a nested delegation's result resolves its own child list into nested? (recursion, B1)", async () => {
  const run = makeRun({ tools: { fake_delegate: fakeDelegate } });
  const { ctx, events } = makeCtx();
  const task = script([
    { text: "delegating", tools: [{ name: "fake_delegate", args: { task: "inner" } }] },
    { text: "done" },
  ]);
  const result = await runInnerLoop(run, ctx, { systemPrompt: async () => "sys", gate: makeGate(["fake_delegate"]) }, task, 4);

  // Live forwarding carried the delegation's result.
  expect(events.some((e) => (e as { type?: string }).type === "tool_result" && (e as { tool?: string }).tool === "fake_delegate")).toBe(true);

  // The returned per-child entry reuses the child's own nested list.
  expect(result.results).toHaveLength(1);
  expect(result.results[0].tool).toBe("fake_delegate");
  expect(result.results[0].nested).toHaveLength(1);
  expect(result.results[0].nested![0].tool).toBe("docs_read");
  expect(result.results[0].nested![0].result).toBe("doc body");
});
