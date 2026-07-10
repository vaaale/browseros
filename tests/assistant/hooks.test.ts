// RunHooks composition + loop integration:
//   npx playwright test -c playwright.unit.config.ts

import { test } from "@playwright/test";
import { strict as assert } from "node:assert";

import { composeHooks, type RunHooks, type HookContext } from "../../src/lib/assistant/hooks";
import { runAgentLoop, type AgentLoopDeps } from "../../src/lib/assistant/agent-loop";
import type { ChatMessage } from "../../src/lib/assistant/messages";
import type { AssistantTool } from "../../src/lib/assistant/tools";

const ctx: HookContext = { runId: "r1", conversationId: "c1", agentId: "a1" };

test.describe("composeHooks", () => {
  test("extendSystemPrompt concatenates contributions", async () => {
    const h = composeHooks([
      { extendSystemPrompt: async () => "part one" },
      { extendSystemPrompt: async () => undefined },
      { extendSystemPrompt: async () => "part two" },
    ]);
    assert.equal(await h.extendSystemPrompt!(ctx), "part one\n\npart two");
  });

  test("beforeToolCall: first deny wins", async () => {
    const h = composeHooks([
      { beforeToolCall: async () => undefined },
      { beforeToolCall: async () => ({ allow: false, reason: "policy A" }) },
      { beforeToolCall: async () => ({ allow: false, reason: "policy B" }) },
    ]);
    const d = await h.beforeToolCall!({ id: "c1", name: "x", arguments: "{}" }, ctx);
    assert.deepEqual(d, { allow: false, reason: "policy A" });
  });

  test("a throwing hook is contained and reported", async () => {
    const errors: string[] = [];
    const h = composeHooks(
      [
        {
          extendSystemPrompt: async () => {
            throw new Error("broken hook");
          },
        },
        { extendSystemPrompt: async () => "survivor" },
      ],
      (msg) => errors.push(msg),
    );
    assert.equal(await h.extendSystemPrompt!(ctx), "survivor");
    assert.equal(errors.length, 1);
    assert.match(errors[0], /broken hook/);
  });

  test("afterToolCall and onRunFinished fan out to every hook", async () => {
    const seen: string[] = [];
    const mk = (id: string): RunHooks => ({
      afterToolCall: async () => void seen.push(`after:${id}`),
      onRunFinished: async () => void seen.push(`finish:${id}`),
    });
    const h = composeHooks([mk("1"), mk("2")]);
    await h.afterToolCall!({ id: "c", name: "t", arguments: "{}" }, "ok", ctx);
    await h.onRunFinished!({ reason: "completed" }, ctx);
    assert.deepEqual(seen, ["after:1", "after:2", "finish:1", "finish:2"]);
  });
});

test.describe("hooks in the loop", () => {
  function loopWith(hooks: RunHooks, opts?: { tools?: Record<string, AssistantTool> }) {
    const store = { messages: [] as ChatMessage[] };
    const systems: string[] = [];
    const deps: AgentLoopDeps = {
      runId: "r1",
      conversationId: "c1",
      agentId: "a1",
      signal: new AbortController().signal,
      emit: () => undefined,
      streamTurn: async (o) => {
        systems.push(o.system);
        // First turn calls the tool (if any registered), second answers.
        const toolNames = Object.keys(opts?.tools ?? {});
        if (toolNames.length && !store.messages.some((m) => m.role === "tool")) {
          return { text: "", toolCalls: [{ id: "call1", name: toolNames[0], arguments: "{}" }] };
        }
        return { text: "final", toolCalls: [] };
      },
      composeSystem: async () => "base prompt",
      tools: opts?.tools ?? {},
      gate: { allow: new Set(), deferred: new Set(), registryIds: new Set(), descriptions: {} },
      io: {
        loadMessages: async () => [...store.messages],
        saveMessages: async (m) => {
          store.messages = [...m];
        },
      },
      awaitFrontendResult: async () => ({ kind: "timeout" }),
      maxSteps: 4,
      toolTimeoutMs: 500,
      hooks: composeHooks([hooks]),
    };
    return { deps, store, systems };
  }

  test("extendSystemPrompt is appended to the composed instructions", async () => {
    const { deps, systems } = loopWith({ extendSystemPrompt: async () => "## Injected context" });
    await runAgentLoop(deps, { userMessage: { content: "hi" } });
    assert.equal(systems[0], "base prompt\n\n## Injected context");
  });

  test("beforeToolCall deny becomes an in-band blocked result and the run continues", async () => {
    const spy: string[] = [];
    const t: AssistantTool = {
      name: "danger",
      description: "",
      parameters: { type: "object", properties: {} },
      execution: "server",
      execute: async () => {
        spy.push("executed");
        return "did it";
      },
    };
    const { deps, store } = loopWith(
      { beforeToolCall: async (call) => (call.name === "danger" ? { allow: false, reason: "not allowed here" } : undefined) },
      { tools: { danger: t } },
    );
    const result = await runAgentLoop(deps, { userMessage: { content: "go" } });
    assert.equal(result.reason, "completed");
    assert.equal(spy.length, 0); // never executed
    const toolMsg = store.messages.find((m) => m.role === "tool")!;
    assert.match(toolMsg.content!, /^Error: danger: blocked: not allowed here/);
  });

  test("afterToolCall observes the settled result; onRunFinished observes the reason", async () => {
    const seen: Array<[string, string]> = [];
    let finished: string | undefined;
    const t: AssistantTool = {
      name: "echo",
      description: "",
      parameters: { type: "object", properties: {} },
      execution: "server",
      execute: async () => "echoed",
    };
    const { deps } = loopWith(
      {
        afterToolCall: async (call, result) => void seen.push([call.name, result]),
        onRunFinished: async (s) => {
          finished = s.reason;
        },
      },
      { tools: { echo: t } },
    );
    const result = await runAgentLoop(deps, { userMessage: { content: "go" } });
    assert.equal(result.reason, "completed");
    assert.deepEqual(seen, [["echo", "echoed"]]);
    assert.equal(finished, "completed");
  });

  test("onRunFinished fires for cancelled runs too", async () => {
    let finished: string | undefined;
    const abort = new AbortController();
    const deps: AgentLoopDeps = {
      runId: "r1",
      conversationId: "c1",
      agentId: "a1",
      signal: abort.signal,
      emit: () => undefined,
      streamTurn: (o) =>
        new Promise((_, reject) => o.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
      composeSystem: async () => "s",
      tools: {},
      gate: { allow: new Set(), deferred: new Set(), registryIds: new Set(), descriptions: {} },
      io: { loadMessages: async () => [], saveMessages: async () => undefined },
      awaitFrontendResult: async () => ({ kind: "timeout" }),
      maxSteps: 4,
      toolTimeoutMs: 500,
      hooks: composeHooks([
        {
          onRunFinished: async (s) => {
            finished = s.reason;
          },
        },
      ]),
    };
    const running = runAgentLoop(deps, { userMessage: { content: "hi" } });
    setTimeout(() => abort.abort(), 20);
    const result = await running;
    assert.equal(result.reason, "cancelled");
    assert.equal(finished, "cancelled");
  });
});
