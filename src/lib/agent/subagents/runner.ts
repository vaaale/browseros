import "server-only";
import { runClaudeAgent } from "./claude-runner";
import { composeInstructions } from "@/lib/agent/instructions";
import type { Agent, AgentRunResult, SubAgentEvent } from "./types";
import type { ChatMessage } from "@/lib/assistant/messages";
import { getMaxAgentSteps } from "@/lib/config/registry";
import { setInRunAgent, clearInRunAgent } from "./in-run-agents";

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
  opts?: { onEvent?: (e: SubAgentEvent) => void; conversationId?: string },
): Promise<AgentRunResult> {
  const [{ runAgentLoop }, { assistantTools }, { gateFor, gateFromAgent }, { streamModelTurn }, { e2eScriptedTurn }, { bridgeEphemeralFrontendTools, headlessGate }] =
    await Promise.all([
      import("@/lib/assistant/agent-loop"),
      import("@/lib/assistant/registry"),
      import("@/lib/assistant/gate"),
      import("@/lib/assistant/model-turn"),
      import("@/lib/assistant/e2e-provider"),
      import("./ephemeral-tools"),
    ]);
  const streamTurn = e2eScriptedTurn(task) ?? streamModelTurn;

  // ADR-12 (Workflow Manager service-tools): an EPHEMERAL agent's gate is built
  // from the in-memory agent object (gateFromAgent) — a getAgent(id) lookup is
  // undefined for it — and headlessGate honors its declared `deferredTools` and
  // bridges its declared frontend VFS tools (file_read/file_write/…) to direct
  // server-side VFS calls (there is no browser to dispatch them to). The BRIDGED
  // tools are what the loop executes against, so a declared file_* tool is
  // genuinely usable. A NAMED agent takes the exact pre-patch path: gateFor(id)
  // and an unbridged, server-only, fully-visible gate — byte-identical.
  const baseTools = assistantTools();
  const tools = agent.ephemeral ? bridgeEphemeralFrontendTools(baseTools, agent.tools) : baseTools;
  const baseGate = agent.ephemeral ? await gateFromAgent(agent) : await gateFor(agent.id);
  const gate = headlessGate(agent, tools, baseGate);
  const maxSteps = await getMaxAgentSteps();

  let messages: ChatMessage[] = [];
  const toolCalls: { tool: string; input: unknown }[] = [];
  // callId → tool name, so a tool_result event can carry its name (the loop's
  // tool_result event only has callId + result — see agent-loop.ts).
  const callNameById = new Map<string, string>();
  let steps = 0;

  const runId = `headless-${agent.id}-${Date.now()}`;
  // ADR-12: register the ephemeral agent under its runId so find_tools can
  // resolve its gate from the in-memory object. Named runs are NOT registered,
  // so named-agent discovery (gateFor) is unchanged.
  if (agent.ephemeral) setInRunAgent(runId, agent);

  try {
    const result = await runAgentLoop(
      {
        runId,
        // The conversation this run belongs to, when it has one (e.g. the
        // /api/subagents/delegate route resolves it). Tools read the active
        // feature branch from it, so an empty value silently means "no branch"
        // and every branch-gated spec write fails. Genuinely headless callers —
        // the scheduler and the Telegram router — legitimately have no
        // conversation and no user to elicit a branch from; there the write
        // failing loudly with the dev_branch_request instruction is the correct
        // outcome, and far better than writing to the live checkout unbranded.
        conversationId: opts?.conversationId ?? "",
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
            callNameById.set(e.callId, e.name);
            toolCalls.push(entry);
            opts?.onEvent?.(entry);
          } else if (e.type === "tool_result") {
            // ADR-13: forward the per-call result with its name + ok/error. The
            // loop already encodes failures as in-band `Error: …` strings, so
            // `ok` is a forward of that convention, not a re-implementation.
            const name = callNameById.get(e.callId) ?? "";
            opts?.onEvent?.({ type: "tool_result", name, result: e.result, ok: !e.result.startsWith("Error: ") });
          } else if (e.type === "reasoning_delta") {
            // ADR-13: stream the model's reasoning so a consuming service can
            // log it (the delegate route forwards these as NDJSON lines).
            opts?.onEvent?.({ type: "reasoning_delta", delta: e.delta });
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
    const output = last?.content ?? "";
    // ADR-13: emit the final assistant text as an event so a consuming service
    // can log it without parsing the done payload.
    opts?.onEvent?.({ type: "final_text", text: output });
    return { agent: agent.name, type: "local", task, output, steps, toolCalls };
  } finally {
    if (agent.ephemeral) clearInRunAgent(runId);
  }
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
    /** The delegating conversation, when there is one — tools resolve the
     *  active feature branch from it (see runLocalHeadless). */
    conversationId?: string;
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
