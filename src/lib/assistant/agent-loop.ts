// The server-owned agent loop (framework-free — every dependency is injected,
// so tests drive it with a scripted provider and an in-memory store).
//
// Contract highlights (docs/plans/2026-07-11-assistant-v2-server-runs.md):
//   - the loop is the ONLY writer of the conversation transcript;
//   - the persisted transcript NEVER contains unanswered tool calls: on stop,
//     the in-flight call and every not-yet-started sibling settle as
//     "Cancelled by user." before run_finished{cancelled};
//   - a stop DURING a model turn discards that partial turn entirely (user
//     decision 2026-07-11) — the transcript ends at the last completed message;
//   - every tool failure (throw, timeout, no client attached) reaches the model
//     as an in-band `Error: <tool>: …` tool result — runs never die of tools;
//   - a turn whose TEXT contains leaked tool-call markup is retried (bounded)
//     instead of being persisted (replaces the client-side ToolCallRetry).

import type { ChatMessage, ToolCallRef } from "./messages";
import { newMessageId, truncateForEdit, deriveRevealedIds } from "./messages";
import type { RunEventInput } from "./run-events";
import type { AssistantTool, ToolDeclaration, ToolGateConfig, ToolContext } from "./tools";
import { visibleTools } from "./tools";
import type { FrontendOutcome } from "./run-manager";
import type { RunHooks, HookContext } from "./hooks";

export interface TurnToolCall {
  id: string;
  name: string;
  /** Raw JSON argument string as produced by the provider. */
  arguments: string;
}

export interface TurnResult {
  text: string;
  toolCalls: TurnToolCall[];
}

export type StreamTurn = (opts: {
  system: string;
  messages: ChatMessage[];
  tools: ToolDeclaration[];
  signal: AbortSignal;
  onDelta: (d: { kind: "text" | "reasoning"; messageId: string; delta: string }) => void;
  messageId: string;
}) => Promise<TurnResult>;

export interface AgentLoopIO {
  /** Load the sanitized transcript (empty array for a fresh conversation). */
  loadMessages(): Promise<ChatMessage[]>;
  /** Replace the transcript (single-writer; used for truncate + every append). */
  saveMessages(messages: ChatMessage[]): Promise<void>;
}

export interface AgentLoopDeps {
  runId: string;
  conversationId: string;
  agentId: string;
  signal: AbortSignal;
  emit: (e: RunEventInput) => void;
  streamTurn: StreamTurn;
  composeSystem: () => Promise<string>;
  tools: Record<string, AssistantTool>;
  gate: ToolGateConfig;
  io: AgentLoopIO;
  /** Dispatch a frontend tool call and await result/timeout/cancel. */
  awaitFrontendResult: (callId: string, timeoutMs: number) => Promise<FrontendOutcome>;
  maxSteps: number;
  /** Total timeout for server tools / await budget for frontend tools. Server
   *  tool progress events reset the deadline (idle semantics for streamers). */
  toolTimeoutMs: number;
  leakRetryLimit?: number;
  /** Pre-composed interception hooks (composeHooks). Optional. */
  hooks?: RunHooks;
}

export interface AgentLoopInput {
  userMessage: { content: string; id?: string };
  /** Edit-resubmit: must identify the LAST user message; the transcript is
   *  truncated from it (inclusive) before the new message is appended. */
  editOfMessageId?: string;
}

const LEAK = /<tool_call\b|<\/tool_call>|<function\s*=|<\|tool[_ ]?call\|>/i;

const STEP_LIMIT_TEXT = (maxSteps: number) =>
  `Reached the step limit (${maxSteps} steps) before finishing. Partial changes may already be applied — review what was done and continue with a focused follow-up rather than restarting from scratch.`;

const CANCELLED_RESULT = "Cancelled by user.";

function toolError(tool: string, detail: string, hint?: string): string {
  return `Error: ${tool}: ${detail}${hint ? ` — ${hint}` : ""}`;
}

/** Run a server tool with kernel guarantees: always settles, in-band errors,
 *  idle-aware timeout (progress events push the deadline). */
async function runServerTool(
  tool: AssistantTool,
  input: Record<string, unknown>,
  ctx: Omit<ToolContext, "onEvent">,
  timeoutMs: number,
  onProgress: (event: unknown) => void,
): Promise<string> {
  if (!tool.execute) return toolError(tool.name, "tool has no server executor", "this is a BOS bug");
  return await new Promise<string>((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout>;
    const settle = (result: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => settle(CANCELLED_RESULT);
    const armTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () =>
          settle(
            toolError(
              tool.name,
              `no result within ${Math.round(timeoutMs / 1000)}s`,
              "the operation may still be running server-side; check its status before retrying",
            ),
          ),
        timeoutMs,
      );
      timer.unref?.();
    };
    armTimer();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    const onEvent = (event: unknown) => {
      armTimer();
      onProgress(event);
    };
    tool
      .execute!(input, { ...ctx, onEvent })
      .then((out) => settle(typeof out === "string" ? out : JSON.stringify(out)))
      .catch((e) => settle(toolError(tool.name, (e as Error).message)));
  });
}

export interface AgentLoopResult {
  reason: "completed" | "cancelled" | "error" | "max_steps";
  error?: string;
}

export async function runAgentLoop(deps: AgentLoopDeps, input: AgentLoopInput): Promise<AgentLoopResult> {
  const { signal, emit, io, hooks } = deps;
  const hookCtx: HookContext = { runId: deps.runId, conversationId: deps.conversationId, agentId: deps.agentId };
  const finish = async (r: AgentLoopResult): Promise<AgentLoopResult> => {
    await hooks?.onRunFinished?.({ reason: r.reason, error: r.error }, hookCtx);
    return r;
  };

  try {
    // ── Transcript entry: (truncate +) append the user message, atomically. ──
    let messages = await io.loadMessages();
    if (input.editOfMessageId) {
      messages = truncateForEdit(messages, input.editOfMessageId);
    }
    const userMessage: ChatMessage = {
      id: input.userMessage.id ?? newMessageId(),
      role: "user",
      content: input.userMessage.content,
    };
    messages = [...messages, userMessage];
    await io.saveMessages(messages);
    emit({ type: "message", message: userMessage });

    let system = await deps.composeSystem();
    const extra = await hooks?.extendSystemPrompt?.(hookCtx);
    if (extra?.trim()) system += `\n\n${extra.trim()}`;
    let leakRetries = 0;
    const leakRetryLimit = deps.leakRetryLimit ?? 2;

    for (let step = 0; step < deps.maxSteps; step++) {
      if (signal.aborted) return finish({ reason: "cancelled" });
      emit({ type: "step_started", step });

      // Visibility is re-derived per step so tools revealed by the previous
      // step's find_tools become callable now.
      const revealed = deriveRevealedIds(messages);
      const declarations = visibleTools(deps.tools, deps.gate, revealed);

      // ── Model turn (streamed). A stop here discards the partial turn. ──
      const messageId = newMessageId();
      let turn: TurnResult;
      try {
        turn = await deps.streamTurn({
          system,
          messages,
          tools: declarations,
          signal,
          messageId,
          onDelta: (d) =>
            emit({
              type: d.kind === "reasoning" ? "reasoning_delta" : "text_delta",
              messageId: d.messageId,
              delta: d.delta,
            }),
        });
      } catch (e) {
        if (signal.aborted) return finish({ reason: "cancelled" });
        return finish({ reason: "error", error: (e as Error).message });
      }
      if (signal.aborted) return finish({ reason: "cancelled" });

      // Leaked tool-call markup in TEXT (local inference servers): retry the
      // turn without persisting the broken one.
      if (turn.toolCalls.length === 0 && LEAK.test(turn.text) && leakRetries < leakRetryLimit) {
        leakRetries++;
        continue;
      }

      // ── Finalize + persist the assistant message. ──
      const toolCallRefs: ToolCallRef[] = turn.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.arguments },
      }));
      const assistantMessage: ChatMessage = {
        id: messageId,
        role: "assistant",
        content: turn.text,
        ...(toolCallRefs.length ? { toolCalls: toolCallRefs } : {}),
      };
      messages = [...messages, assistantMessage];
      await io.saveMessages(messages);
      emit({ type: "message", message: assistantMessage });

      if (toolCallRefs.length === 0) return finish({ reason: "completed" });

      // ── Execute tool calls sequentially. Once the assistant message is
      // persisted, EVERY call gets an answer — execution, in-band error, or
      // "Cancelled by user." — before the loop can end. ──
      let cancelledMidTools = false;
      for (const call of turn.toolCalls) {
        let result: string;
        const tool = deps.tools[call.name];
        const execution = tool?.execution ?? "frontend";

        if (cancelledMidTools || signal.aborted) {
          cancelledMidTools = true;
          emit({ type: "tool_cancelled", callId: call.id });
          result = CANCELLED_RESULT;
        } else {
          emit({ type: "tool_call", callId: call.id, name: call.name, args: call.arguments, execution });
          const decision = await hooks?.beforeToolCall?.(call, hookCtx);
          if (decision && decision.allow === false) {
            result = toolError(call.name, `blocked${decision.reason ? `: ${decision.reason}` : " by policy"}`);
          } else if (!tool) {
            result = toolError(call.name, "unknown tool", "use find_tools to discover available tools");
          } else if (tool.execution === "server") {
            let parsed: Record<string, unknown> = {};
            try {
              parsed = call.arguments ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
            } catch {
              /* leave {} — the tool reports its own validation error */
            }
            result = await runServerTool(
              tool,
              parsed,
              { signal, conversationId: deps.conversationId, agentId: deps.agentId },
              deps.toolTimeoutMs,
              (event) => emit({ type: "tool_progress", callId: call.id, event }),
            );
          } else {
            const outcome = await deps.awaitFrontendResult(call.id, deps.toolTimeoutMs);
            result =
              outcome.kind === "result"
                ? outcome.result
                : outcome.kind === "timeout"
                  ? toolError(
                      call.name,
                      `no client executed the tool within ${Math.round(deps.toolTimeoutMs / 1000)}s`,
                      "the user's browser may be closed; the task can continue without this tool or be retried later",
                    )
                  : CANCELLED_RESULT;
          }
          if (signal.aborted) cancelledMidTools = true;
          if (result === CANCELLED_RESULT) emit({ type: "tool_cancelled", callId: call.id });
        }

        await hooks?.afterToolCall?.(call, result, hookCtx);
        const toolMessage: ChatMessage = {
          id: newMessageId(),
          role: "tool",
          content: result,
          toolCallId: call.id,
        };
        messages = [...messages, toolMessage];
        await io.saveMessages(messages);
        emit({ type: "tool_result", callId: call.id, result });
        emit({ type: "message", message: toolMessage });
      }
      if (cancelledMidTools || signal.aborted) return finish({ reason: "cancelled" });
    }

    // ── Step limit: close the turn in-band so the transcript stays settled. ──
    const limitMessage: ChatMessage = {
      id: newMessageId(),
      role: "assistant",
      content: STEP_LIMIT_TEXT(deps.maxSteps),
    };
    messages = [...messages, limitMessage];
    await io.saveMessages(messages);
    emit({ type: "message", message: limitMessage });
    return finish({ reason: "max_steps" });
  } catch (e) {
    return finish({ reason: "error", error: (e as Error).message });
  }
}
