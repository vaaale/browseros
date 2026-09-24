import "server-only";
import { runClaudeAgent } from "./claude-runner";
import { composeInstructions } from "@/lib/agent/instructions";
import { TranscriptionWriter } from "./transcript";
import { registerRun, unregisterRun } from "./run-registry";
import type { Agent, AgentRunResult, AgentRunUsage, SubAgentEvent } from "./types";
import type { ChatMessage } from "@/lib/assistant/messages";
import type { TokenUsage } from "@/lib/assistant/agent-loop";
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
  opts?: { onEvent?: (e: SubAgentEvent) => void; conversationId?: string; runId?: string; parentRunId?: string },
): Promise<AgentRunResult> {
  const [{ runAgentLoop }, { assistantTools }, { gateFor, gateFromAgent }, { streamModelTurn }, { e2eScriptedTurn }, { headlessGate }] =
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
  // undefined for it — and headlessGate honors its declared `deferredTools`.
  // A NAMED agent takes gateFor(id) and a server-only, fully-visible gate.
  //
  // There is no longer a frontend-VFS bridge here. ADR-12 added one because
  // file_read/file_write were frontend-execution tools that a headless run had
  // no browser to dispatch to — but it only ever applied to EPHEMERAL agents,
  // so a headless NAMED agent (Build Studio, self-heal) still could not write a
  // file at all. Those six tools are server tools now, which fixes both cases
  // at the source instead of bridging one of them.
  const tools = assistantTools();
  const baseGate = agent.ephemeral ? await gateFromAgent(agent) : await gateFor(agent.id);
  const gate = headlessGate(agent, tools, baseGate);
  const maxSteps = await getMaxAgentSteps();

  let messages: ChatMessage[] = [];
  const toolCalls: { tool: string; input: unknown }[] = [];
  // callId → tool name, so a tool_result event can carry its name (the loop's
  // tool_result event only has callId + result — see agent-loop.ts).
  const callNameById = new Map<string, string>();
  let steps = 0;

  const runId = opts?.runId ?? `headless-${agent.id}-${Date.now()}`;
  // ADR-12: register the ephemeral agent under its runId so find_tools can
  // resolve its gate from the in-memory object. Named runs are NOT registered,
  // so named-agent discovery (gateFor) is unchanged.
  if (agent.ephemeral) setInRunAgent(runId, agent);

  // 031-self-healing scope-add. Three additive wirings, none of which changes
  // what an existing caller observes:
  //
  //  (1) ADR-11 — the run's AbortController is now created HERE (it used to be
  //      constructed inline and thrown away) and registered by runId, so
  //      `abortHeadlessRun` can stop this run. The loop already honors the
  //      signal at every step boundary and links each tool's own abort to it,
  //      so this is a handle on existing machinery, not a new cancel path.
  //  (2) ADR-12 — a leading `run_started` event, so a fire-and-forget caller
  //      learns the runId while the run is still in flight. It is emitted on
  //      `opts.onEvent` before anything else; the loop's internal `emit` is the
  //      loop's own vocabulary and is untouched.
  //  (3) ADR-10 — a config-gated transcript observer fed from the SAME emit
  //      handler that already forwards events, so it costs one no-op check per
  //      event when disabled.
  const controller = new AbortController();
  registerRun(runId, {
    abort: () => controller.abort(),
    agentId: agent.id,
    ...(opts?.parentRunId ? { parentRunId: opts.parentRunId } : {}),
  });
  opts?.onEvent?.({
    type: "run_started",
    runId,
    agentId: agent.id,
    startedAt: new Date().toISOString(),
    ...(opts?.parentRunId ? { parentRunId: opts.parentRunId } : {}),
  });

  const transcript = new TranscriptionWriter();
  await transcript.open(agent.id, runId, task, {
    agentName: agent.name,
    kind: "local",
    ...(opts?.parentRunId ? { parentRunId: opts.parentRunId } : {}),
  });
  // Reasoning arrives as one event per token; buffered and flushed at the next
  // turn boundary so the transcript is one line per turn, not one per token
  // (ADR-10's per-turn cadence — this is a shared platform path).
  let reasoning = "";
  const flushReasoning = () => {
    if (!reasoning.trim()) return;
    void transcript.appendReasoning(reasoning);
    reasoning = "";
  };

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
        signal: controller.signal,
        emit: (e) => {
          if (e.type === "step_started") {
            steps = e.step + 1;
          } else if (e.type === "message") {
            // The loop's own per-turn boundary (the same one `io.saveMessages`
            // uses) — the transcript's assistant line, and nothing else.
            if (e.message.role === "assistant" && e.message.content) {
              flushReasoning();
              void transcript.appendAssistantText(e.message.content);
            }
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
            flushReasoning();
            void transcript.appendToolCall(e.name, input, e.callId);
            opts?.onEvent?.(entry);
          } else if (e.type === "tool_result") {
            // ADR-13: forward the per-call result with its name + ok/error. The
            // loop already encodes failures as in-band `Error: …` strings, so
            // `ok` is a forward of that convention, not a re-implementation.
            const name = callNameById.get(e.callId) ?? "";
            const ok = !e.result.startsWith("Error: ");
            void transcript.appendToolResult(name, e.result, ok, e.callId);
            opts?.onEvent?.({ type: "tool_result", name, result: e.result, ok });
          } else if (e.type === "reasoning_delta") {
            // ADR-13: stream the model's reasoning so a consuming service can
            // log it (the delegate route forwards these as NDJSON lines).
            reasoning += e.delta;
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

    const usage = toRunUsage(result.usage);
    // M1 (ADR-13): the loop's end reason is surfaced on BOTH returns. Before
    // the scope-add only `error` was special-cased and `completed`/`cancelled`/
    // `max_steps` collapsed into one indistinguishable clean return — which
    // made a run that exhausted its step budget look like a completed one, and
    // FR-033(b)'s max-steps detection unreachable.
    if (result.reason === "error") {
      return {
        agent: agent.name,
        type: "local",
        task,
        output: "",
        steps,
        toolCalls,
        error: result.error,
        runId,
        endedReason: "error",
        ...(usage ? { usage } : {}),
      };
    }
    const last = [...messages].reverse().find((m) => m.role === "assistant");
    const output = last?.content ?? "";
    // ADR-13: emit the final assistant text as an event so a consuming service
    // can log it without parsing the done payload.
    opts?.onEvent?.({ type: "final_text", text: output });
    return {
      agent: agent.name,
      type: "local",
      task,
      output,
      steps,
      toolCalls,
      runId,
      endedReason: result.reason,
      ...(result.reason === "cancelled" ? { aborted: true } : {}),
      ...(usage ? { usage } : {}),
    };
  } finally {
    flushReasoning();
    // The abort path lands here too (the loop returns `cancelled`), so the
    // partial transcript and its `aborted` mark are written by the SAME end
    // path a clean completion uses — there is no abort-only writer (ADR-11).
    await transcript.finalize({ aborted: controller.signal.aborted });
    unregisterRun(runId);
    if (agent.ephemeral) clearInRunAgent(runId);
  }
}

/** Lift the loop's per-run TokenUsage into the public AgentRunResult shape
 *  (adds the derived `totalTokens`). Undefined in, undefined out — a run whose
 *  provider reported nothing must not surface a fabricated zero cost. */
function toRunUsage(usage: TokenUsage | undefined): AgentRunUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.inputTokens + usage.outputTokens,
    ...(usage.cacheReadTokens ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
  };
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
    /** Use this runId instead of generating one (031-self-healing scope-add).
     *  Only a caller that must know the id BEFORE the run starts needs it. */
    runId?: string;
    /** The run that is delegating this one, so the run registry can cascade an
     *  abort from parent to child (ADR-11). */
    parentRunId?: string;
  },
): Promise<AgentRunResult> {
  if (agent.type === "claude") {
    // Development must be done by Claude — no local-provider fallback here.
    return runClaudeAgent(agent, task, opts);
  }
  // Resolved here so the failure return below can name the run too: `runId` is
  // required on AgentRunResult, and a caller that got a result with no id could
  // not look up its transcript.
  const runId = opts?.runId ?? `headless-${agent.id}-${Date.now()}`;
  try {
    return await runLocalHeadless(agent, task, { ...opts, runId });
  } catch (e) {
    return {
      agent: agent.name,
      type: "local",
      task,
      output: "",
      steps: 0,
      toolCalls: [],
      error: (e as Error).message,
      runId,
      endedReason: "error",
    };
  }
}
