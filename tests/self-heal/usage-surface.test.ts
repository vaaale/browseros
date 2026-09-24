import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { addUsage, runAgentLoop, type StreamTurn, type TokenUsage } from "../../src/lib/assistant/agent-loop";
import { _usageInternals } from "../../src/lib/assistant/model-turn";
import { _harnessUsageInternals } from "../../src/lib/agent/subagents/claude-runner";
import type { ChatMessage } from "../../src/lib/assistant/messages";

// 031-self-healing ADR-5, milestone 1 — "surface usage".
//
// Before this, BOS did not know what its own agent runs cost: `TurnResult` and
// `AgentRunResult` had no usage field and `anthropicTurn` never read
// `message_delta`. The self-heal cost cap has to be enforceable against REAL
// provider-reported tokens, not an estimate, so usage now propagates
// turn → loop → run.
//
// The invariant these tests protect: `undefined` means UNKNOWN and must never
// become a fabricated zero, because a run that looks free is a run that never
// counts against the cap.

test.describe("addUsage", () => {
  test("sums across turns", () => {
    const total = addUsage(
      { inputTokens: 100, outputTokens: 20 },
      { inputTokens: 300, outputTokens: 50, cacheReadTokens: 90 },
    );
    expect(total).toEqual({ inputTokens: 400, outputTokens: 70, cacheReadTokens: 90 });
  });

  test("treats undefined as 'nothing reported', not zero", () => {
    expect(addUsage(undefined, undefined)).toBeUndefined();
    expect(addUsage({ inputTokens: 1, outputTokens: 2 }, undefined)).toEqual({ inputTokens: 1, outputTokens: 2 });
    expect(addUsage(undefined, { inputTokens: 3, outputTokens: 4 })).toEqual({ inputTokens: 3, outputTokens: 4 });
  });

  test("omits zero cache counters rather than emitting noise", () => {
    const total = addUsage({ inputTokens: 1, outputTokens: 1 }, { inputTokens: 1, outputTokens: 1 });
    expect(total).toEqual({ inputTokens: 2, outputTokens: 2 });
  });
});

test.describe("provider usage extraction (model-turn.ts)", () => {
  const { toTokenUsage, mergeTurnUsage } = _usageInternals;

  test("reads the Anthropic shape, including cache counters", () => {
    expect(
      toTokenUsage({ input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 800, cache_creation_input_tokens: 60 }),
    ).toEqual({ inputTokens: 1200, outputTokens: 340, cacheReadTokens: 800, cacheWriteTokens: 60 });
  });

  test("reads the OpenAI shape", () => {
    expect(toTokenUsage({ prompt_tokens: 500, completion_tokens: 25 })).toEqual({ inputTokens: 500, outputTokens: 25 });
  });

  test("a partial report still counts what it knows", () => {
    expect(toTokenUsage({ output_tokens: 7 })).toEqual({ inputTokens: 0, outputTokens: 7 });
  });

  test("a body with no recognizable fields is UNKNOWN, not zero", () => {
    expect(toTokenUsage(undefined)).toBeUndefined();
    expect(toTokenUsage(null)).toBeUndefined();
    expect(toTokenUsage("nope")).toBeUndefined();
    expect(toTokenUsage({})).toBeUndefined();
    expect(toTokenUsage({ total_cost_usd: 0.02 })).toBeUndefined();
    expect(toTokenUsage({ input_tokens: "many" })).toBeUndefined();
  });

  test("mergeTurnUsage takes the max per field — Anthropic reports one turn twice", () => {
    // message_start carries the input/cache counts and a partial output count;
    // message_delta carries the final output count. Neither may regress the
    // other.
    const start = toTokenUsage({ input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 900 });
    const delta = toTokenUsage({ output_tokens: 512 });
    expect(mergeTurnUsage(start, delta)).toEqual({
      inputTokens: 1000,
      outputTokens: 512,
      cacheReadTokens: 900,
    });
  });

  test("mergeTurnUsage passes an absent side through", () => {
    expect(mergeTurnUsage(undefined, { inputTokens: 1, outputTokens: 1 })).toEqual({ inputTokens: 1, outputTokens: 1 });
    expect(mergeTurnUsage({ inputTokens: 1, outputTokens: 1 }, undefined)).toEqual({ inputTokens: 1, outputTokens: 1 });
    expect(mergeTurnUsage(undefined, undefined)).toBeUndefined();
  });
});

test.describe("harness usage extraction (claude-runner.ts)", () => {
  const { parseHarnessUsage, parseOpenCodeUsage } = _harnessUsageInternals;

  test("parses the Claude Code stream-json result line", () => {
    // The real shape of the `type:"result"` line's usage object.
    expect(
      parseHarnessUsage({
        input_tokens: 24,
        output_tokens: 1_512,
        cache_read_input_tokens: 41_000,
        cache_creation_input_tokens: 2_100,
      }),
    ).toEqual({
      inputTokens: 24,
      outputTokens: 1_512,
      totalTokens: 1_536,
      cacheReadTokens: 41_000,
      cacheWriteTokens: 2_100,
    });
  });

  test("honors a harness-declared total over the derived sum", () => {
    expect(parseHarnessUsage({ input_tokens: 10, output_tokens: 5, total_tokens: 999 })?.totalTokens).toBe(999);
  });

  test("parses OpenCode's nested tokens shape from a step event", () => {
    expect(parseOpenCodeUsage({ part: { tokens: { input: 700, output: 90, cache: { read: 300, write: 10 } } } })).toEqual({
      inputTokens: 700,
      outputTokens: 90,
      totalTokens: 790,
      cacheReadTokens: 300,
      cacheWriteTokens: 10,
    });
  });

  test("parses a top-level OpenCode usage field too", () => {
    expect(parseOpenCodeUsage({ usage: { input: 5, output: 5 } })?.totalTokens).toBe(10);
  });

  test("an event with no usage anywhere reports nothing", () => {
    expect(parseOpenCodeUsage({})).toBeUndefined();
    expect(parseOpenCodeUsage({ part: {} })).toBeUndefined();
    expect(parseHarnessUsage(undefined)).toBeUndefined();
    expect(parseHarnessUsage({ total_cost_usd: 0.5 })).toBeUndefined();
  });
});

// ── The propagation path: turn → loop ──────────────────────────────────────
//
// The loop is fully injectable (framework-free by design), so this drives it
// with a scripted provider and asserts the usage actually arrives on the
// result — the thing the cost ledger reads.

function loopDeps(streamTurn: StreamTurn, saved: ChatMessage[]) {
  return {
    runId: "r-1",
    conversationId: "",
    agentId: "test",
    signal: new AbortController().signal,
    emit: () => {},
    streamTurn,
    composeSystem: async () => "system",
    tools: {},
    gate: { allow: new Set<string>(), deferred: new Set<string>(), registryIds: new Set<string>(), descriptions: {} },
    io: {
      loadMessages: async () => [] as ChatMessage[],
      saveMessages: async (m: ChatMessage[]) => {
        saved.length = 0;
        saved.push(...m);
      },
    },
    awaitFrontendResult: async () => ({ kind: "timeout" }) as const,
    maxSteps: 4,
    toolTimeoutMs: 1_000,
  };
}

test.describe("usage propagation into the run result", () => {
  test("a single turn's usage reaches AgentLoopResult", async () => {
    const saved: ChatMessage[] = [];
    const streamTurn: StreamTurn = async () => ({
      text: "done",
      toolCalls: [],
      usage: { inputTokens: 900, outputTokens: 100 } as TokenUsage,
    });
    const result = await runAgentLoop(loopDeps(streamTurn, saved), { userMessage: { content: "hi" } });
    expect(result.reason).toBe("completed");
    expect(result.usage).toEqual({ inputTokens: 900, outputTokens: 100 });
  });

  test("usage from every turn is summed across a multi-step run", async () => {
    const saved: ChatMessage[] = [];
    let turn = 0;
    const streamTurn: StreamTurn = async () => {
      turn += 1;
      if (turn === 1) {
        return {
          text: "",
          toolCalls: [{ id: "c1", name: "unknown_tool", arguments: "{}" }],
          usage: { inputTokens: 100, outputTokens: 10 },
        };
      }
      return { text: "done", toolCalls: [], usage: { inputTokens: 200, outputTokens: 20 } };
    };
    const result = await runAgentLoop(loopDeps(streamTurn, saved), { userMessage: { content: "hi" } });
    expect(result.reason).toBe("completed");
    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 30 });
  });

  test("a provider that reports nothing leaves usage undefined — never a free run", async () => {
    const saved: ChatMessage[] = [];
    const streamTurn: StreamTurn = async () => ({ text: "done", toolCalls: [] });
    const result = await runAgentLoop(loopDeps(streamTurn, saved), { userMessage: { content: "hi" } });
    expect(result.usage).toBeUndefined();
  });

  test("a FAILED turn still reports what it cost up to the failure", async () => {
    const saved: ChatMessage[] = [];
    let turn = 0;
    const streamTurn: StreamTurn = async () => {
      turn += 1;
      if (turn === 1) {
        return {
          text: "",
          toolCalls: [{ id: "c1", name: "unknown_tool", arguments: "{}" }],
          usage: { inputTokens: 100, outputTokens: 10 },
        };
      }
      throw new Error("provider exploded");
    };
    const result = await runAgentLoop(loopDeps(streamTurn, saved), { userMessage: { content: "hi" } });
    expect(result.reason).toBe("error");
    // The first turn was real spend and must still be billable.
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 10 });
  });
});
