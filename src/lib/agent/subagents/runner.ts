import "server-only";
import type { ToolEvent } from "@/lib/agent/llm";
import { runClaudeAgent } from "./claude-runner";
import { composeInstructions } from "@/lib/agent/instructions";
import type { Agent, AgentRunResult } from "./types";
import type { ChatMessage } from "@/lib/assistant/messages";

export type SubAgentEvent = ToolEvent;

// Headless (non-chat) local-agent execution (025-agent-delegation-v2, Phase
// 4). `agent_delegate`/`dev_delegate` (assistant chat delegation) no longer
// call this at all — they run through `runInnerLoop` directly, sharing the
// live chat Run (`tools/server/delegate-common.ts`). This function remains
// for the OTHER real callers that delegate to a `type: "local"` agent with NO
// live Run/browser attachment: Telegram bot routing
// (`integrations/services/telegram/agent-router.ts`), workflow steps
// (`workflows/runner.ts`), scheduled "prompt" jobs (`scheduler/executor.ts`),
// and the standalone `/api/subagents/delegate` route. It resolves tools from
// the SAME v2 registry as everything else (FR-001) — filtered to
// server-executable only, since there is no browser to ever dispatch a
// frontend tool to.
//
// Uses runtime `import()` for `@/lib/assistant/*` (registry/gate/agent-loop)
// deliberately, not a top-level import: `assistantTools()` composes
// `agent_delegate`/`dev_delegate`, which import `runSubAgent` from THIS file
// for the `type: "claude"` path — a top-level import here would be a real
// circular dependency. `scheduler/executor.ts` already uses this same
// dynamic-import pattern for `runSubAgent` itself, for the same reason.
async function runLocalHeadless(
  agent: Agent,
  task: string,
  opts?: { onEvent?: (e: SubAgentEvent) => void },
): Promise<AgentRunResult> {
  const [{ runAgentLoop }, { assistantTools }, { gateFor, gateFromAgent }, { streamModelTurn }, { defaultMaxSteps }, { e2eScriptedTurn }] =
    await Promise.all([
      import("@/lib/assistant/agent-loop"),
      import("@/lib/assistant/registry"),
      import("@/lib/assistant/gate"),
      import("@/lib/assistant/model-turn"),
      import("@/lib/assistant/inner-loop"),
      import("@/lib/assistant/e2e-provider"),
    ]);
  const streamTurn = e2eScriptedTurn(task) ?? streamModelTurn;

  const tools = assistantTools();
  const baseGate = agent.ephemeral ? await gateFromAgent(agent) : await gateFor(agent.id);
  const gate = {
    allow: new Set([...baseGate.allow].filter((id) => tools[id]?.execution === "server")),
    deferred: new Set<string>(), // headless: always fully visible, no discovery round-trip
    registryIds: baseGate.registryIds,
    descriptions: baseGate.descriptions,
  };
  const maxSteps = defaultMaxSteps(gate);

  let messages: ChatMessage[] = [];
  const toolCalls: { tool: string; input: unknown }[] = [];
  let steps = 0;

  const result = await runAgentLoop(
    {
      runId: `headless-${agent.id}-${Date.now()}`,
      conversationId: "",
      agentId: agent.id,
      signal: new AbortController().signal,
      emit: (e) => {
        if (e.type === "step_started") {
          steps = e.step + 1;
        } else if (e.type === "tool_call") {
          let input: unknown;
          try {
            input = e.args ? JSON.parse(e.args) : {};
          } catch {
            input = e.args;
          }
          const entry = { tool: e.name, input };
          toolCalls.push(entry);
          opts?.onEvent?.(entry);
        }
      },
      streamTurn,
      composeSystem: async () => (agent.ephemeral ? agent.systemPrompt : await composeInstructions(agent.id)),
      tools,
      gate,
      io: {
        loadMessages: async () => [],
        saveMessages: async (m) => {
          messages = m;
        },
      },
      awaitFrontendResult: async () => ({ kind: "timeout" }),
      maxSteps,
      toolTimeoutMs: 600_000,
    },
    { userMessage: { content: task } },
  );

  if (result.reason === "error") {
    return { agent: agent.name, type: "local", task, output: "", steps, toolCalls, error: result.error };
  }
  const last = [...messages].reverse().find((m) => m.role === "assistant");
  return { agent: agent.name, type: "local", task, output: last?.content ?? "", steps, toolCalls };
}

/** Run a sub-agent. `type: "claude"` agents run as Claude Code (headless CLI
 *  or MCP harness) so development is actually done by Claude — unaffected by
 *  025-agent-delegation-v2's registry unification (FR-024(a)). `type: "local"`
 *  runs headlessly (see `runLocalHeadless` above) — assistant-chat delegation
 *  (`agent_delegate`/`dev_delegate`) never reaches this function for local
 *  agents; it calls `runInnerLoop` directly instead. */
export async function runSubAgent(
  agent: Agent,
  task: string,
  opts?: {
    onEvent?: (e: SubAgentEvent) => void;
    contentOnly?: boolean;
    depth?: number;
    // Server-resolved branch for source edits. It is deliberately not part of the
    // public LLM tool schema; callers resolve it from Assistant/workflow state.
    featureBranch?: string;
    interactive?: boolean;
  },
): Promise<AgentRunResult> {
  if (agent.type === "claude") {
    // Development must be done by Claude — no local-provider fallback here.
    return runClaudeAgent(agent, task, opts);
  }
  try {
    return await runLocalHeadless(agent, task, opts);
  } catch (e) {
    return { agent: agent.name, type: "local", task, output: "", steps: 0, toolCalls: [], error: (e as Error).message };
  }
}
