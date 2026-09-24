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

import type { ChatMessage, ToolCallRef, Attachment } from "./messages";
import { newMessageId, truncateForEdit, deriveRevealedIds } from "./messages";
import type { RunEventInput } from "./run-events";
import type { AssistantTool, ToolDeclaration, ToolGateConfig, ToolContext, ToolExecuteResult } from "./tools";
import { visibleTools } from "./tools";
import type { FrontendOutcome } from "./run-manager";
import type { RunHooks, HookContext } from "./hooks";
import { logger } from "@/lib/logging";

export interface TurnToolCall {
  id: string;
  name: string;
  /** Raw JSON argument string as produced by the provider. */
  arguments: string;
}

/** Provider-reported token usage for ONE model turn (031-self-healing ADR-5).
 *  Optional everywhere: some providers (and most local inference servers) never
 *  report it, so every consumer must tolerate `undefined` rather than assume 0. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Sum two usages, treating `undefined` as "nothing reported" (not zero) — so
 *  a run where no turn reported usage stays `undefined` instead of becoming a
 *  misleading 0. */
export function addUsage(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  const cacheRead = (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0);
  const cacheWrite = (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(cacheRead ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite ? { cacheWriteTokens: cacheWrite } : {}),
  };
}

export interface TurnResult {
  text: string;
  toolCalls: TurnToolCall[];
  /** Provider-reported usage for this turn, when the provider reports it. */
  usage?: TokenUsage;
}

export type StreamTurn = (opts: {
  system: string;
  messages: ChatMessage[];
  tools: ToolDeclaration[];
  signal: AbortSignal;
  onDelta: (d: { kind: "text" | "reasoning"; messageId: string; delta: string }) => void;
  messageId: string;
  /** For server-side compaction keyed by conversation (empty in unit tests). */
  conversationId: string;
  /** Run identifier sent as X-Correlation-Id on every LLM API call so individual
   *  model turns are traceable in provider dashboards / observability tools. */
  runId: string;
  /** 025-agent-delegation-v2: optional model-name override (e.g. a named
   *  agent's `model` field) — same provider/apiKey/baseUrl, different model
   *  string. Undefined for the primary run and for ephemeral/surface agents. */
  model?: string;
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
  /** Nested-delegation depth (025-agent-delegation-v2): 0 for the primary run,
   *  threaded through to every server tool's ToolContext so agent_delegate/
   *  dev_delegate can enforce a depth guard uniformly. */
  delegationDepth?: number;
  /** Ceiling on how many `parallelSafe` tool calls run concurrently in one
   *  batch. Bounds resource use when a model emits a large fan-out (10 web
   *  fetches, 8 sub-agent delegations) — without it a single turn could open
   *  arbitrarily many sockets/sub-runs at once. */
  maxParallelTools?: number;
}

export interface AgentLoopInput {
  userMessage: { content: string; id?: string; attachments?: Attachment[] };
  /** Edit-resubmit: must identify the LAST user message; the transcript is
   *  truncated from it (inclusive) before the new message is appended. */
  editOfMessageId?: string;
}

const LEAK = /<tool_call\b|<\/tool_call>|<function\s*=|<\|tool[_ ]?call\|>/i;

export const STEP_LIMIT_TEXT = (maxSteps: number) =>
  `Reached the step limit (${maxSteps} steps) before finishing. Partial changes may already be applied — review what was done and continue with a focused follow-up rather than restarting from scratch.`;

const CANCELLED_RESULT = "Cancelled by user.";

/** Default ceiling on concurrent parallel-safe tool calls (see maxParallelTools). */
export const DEFAULT_MAX_PARALLEL_TOOLS = 6;

function toolError(tool: string, detail: string, hint?: string): string {
  return `Error: ${tool}: ${detail}${hint ? ` — ${hint}` : ""}`;
}

interface CallOutcome {
  result: string;
  attachments?: Attachment[];
}

/**
 * Group a turn's tool calls into execution batches.
 *
 * A batch is a maximal run of ADJACENT calls whose tools opted into
 * `parallelSafe`, capped at `maxParallel`. Anything else is a batch of one.
 *
 * Adjacency is the safety property that makes this sound: relative order is
 * never changed, so a write can never be reordered around a read. Given
 * [read, read, write, read] the batches are [read, read], [write], [read] —
 * the two leading reads overlap, but the write still happens strictly after
 * them and the trailing read strictly after the write. Grouping every safe
 * call in the turn regardless of position would break exactly that.
 *
 * Exported for tests.
 */
export function batchToolCalls(
  calls: TurnToolCall[],
  tools: Record<string, AssistantTool>,
  maxParallel: number,
): TurnToolCall[][] {
  const limit = Math.max(1, maxParallel);
  const batches: TurnToolCall[][] = [];
  let current: TurnToolCall[] = [];
  const flush = () => {
    if (current.length) batches.push(current);
    current = [];
  };
  for (const call of calls) {
    // An unknown tool is never parallel-safe — it resolves to an in-band error,
    // and keeping it sequential keeps the "unknown tool" path exactly as it was.
    if (tools[call.name]?.parallelSafe !== true) {
      flush();
      batches.push([call]);
      continue;
    }
    current.push(call);
    if (current.length >= limit) flush();
  }
  flush();
  return batches;
}

/** Run a server tool with kernel guarantees: always settles, in-band errors,
 *  idle-aware timeout (progress events push the deadline).
 *
 *  025-agent-delegation-v2: `tool.execute()` is handed a PER-CALL abort signal
 *  (`callAbort.signal`), not the bare run signal — it aborts on either the
 *  run's real cancellation OR this call's own idle-timeout firing. Without
 *  this, a tool whose execute() runs a long nested operation (e.g. a
 *  delegation's inner loop) would keep running detached after this function
 *  already settled with an in-band timeout error to the model. */
async function runServerTool(
  tool: AssistantTool,
  input: Record<string, unknown>,
  ctx: Omit<ToolContext, "onEvent" | "elicit">,
  timeoutMs: number,
  onProgress: (event: unknown) => void,
  awaitFrontendResult: (callId: string, timeout: number) => Promise<FrontendOutcome>,
  emitEvent: (e: RunEventInput) => void,
): Promise<string | ToolExecuteResult> {
  if (!tool.execute) return toolError(tool.name, "tool has no server executor", "this is a BOS bug");
  const callAbort = new AbortController();
  return await new Promise<string | ToolExecuteResult>((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout>;
    const settle = (result: string | ToolExecuteResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => {
      callAbort.abort();
      settle(CANCELLED_RESULT);
    };
    const armTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        logger().log({
          level: "warn",
          component: "assistant.tools",
          conversation: ctx.conversationId,
          msg: "server tool timed out",
          data: {
            conversationId: ctx.conversationId,
            agentId: ctx.agentId,
            tool: tool.name,
            timeoutMs,
          },
        });
        callAbort.abort();
        settle(
          toolError(
            tool.name,
            `no result within ${Math.round(timeoutMs / 1000)}s`,
            "the operation may still be running server-side; check its status before retrying",
          ),
        );
      }, timeoutMs);
      timer.unref?.();
    };
    armTimer();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    const onEvent = (event: unknown) => {
      armTimer();
      onProgress(event);
    };
    // Inline elicitation: emits a frontend tool_call to the NDJSON stream,
    // then waits for the user's response exactly like the loop does for a
    // real frontend tool. Re-arms the idle timer so a slow user response
    // does not trigger the server-tool timeout.
    const elicit = async (toolName: string, args: Record<string, unknown>): Promise<string> => {
      const elicitCallId = newMessageId();
      onEvent({ type: "elicitation_started", tool: toolName }); // re-arm timer
      emitEvent({ type: "tool_call", callId: elicitCallId, name: toolName, args: JSON.stringify(args), execution: "frontend" });
      const outcome = await awaitFrontendResult(elicitCallId, timeoutMs);
      if (outcome.kind === "result") return outcome.result;
      throw new Error(outcome.kind === "timeout" ? "elicitation timed out" : "cancelled by user");
    };
    tool
      .execute!(input, { ...ctx, signal: callAbort.signal, onEvent, elicit })
      .then((out) => settle(out))
      .catch((e) => settle(toolError(tool.name, (e as Error).message)));
  });
}

export interface AgentLoopResult {
  reason: "completed" | "cancelled" | "error" | "max_steps";
  error?: string;
  /** Token usage summed across every model turn in this run (031-self-healing
   *  ADR-5). `undefined` when no turn reported any — never a fabricated 0. */
  usage?: TokenUsage;
}

export async function runAgentLoop(deps: AgentLoopDeps, input: AgentLoopInput): Promise<AgentLoopResult> {
  const { signal, emit, io, hooks } = deps;
  const hookCtx: HookContext = { runId: deps.runId, conversationId: deps.conversationId, agentId: deps.agentId };
  // Accumulated across every completed model turn, so the run's total is
  // available on EVERY exit path (completed, cancelled, error, max_steps) —
  // a cancelled run still cost what it cost (031-self-healing ADR-5).
  let runUsage: TokenUsage | undefined;
  const finish = async (r: AgentLoopResult): Promise<AgentLoopResult> => {
    await hooks?.onRunFinished?.({ reason: r.reason, error: r.error }, hookCtx);
    return runUsage ? { ...r, usage: runUsage } : r;
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
      ...(input.userMessage.attachments?.length ? { attachments: input.userMessage.attachments } : {}),
    };
    messages = [...messages, userMessage];
    await io.saveMessages(messages);
    emit({ type: "message", message: userMessage });

    // Plugin hook: beforeRun — plugins may add ephemeral context (e.g. memory
    // injection) for the model. The return value becomes the model context for
    // this run but is NEVER persisted — `messages` stays as the canonical
    // transcript for every io.saveMessages call.
    const hookModified = await hooks?.beforeRun?.(messages, hookCtx);
    let contextMessages = hookModified ?? messages;

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
      let reasoningBuf = "";
      let turn: TurnResult;
      try {
        turn = await deps.streamTurn({
          system,
          messages: contextMessages,
          tools: declarations,
          signal,
          messageId,
          conversationId: deps.conversationId,
          runId: deps.runId,
          onDelta: (d) => {
            if (d.kind === "reasoning") reasoningBuf += d.delta;
            emit({
              type: d.kind === "reasoning" ? "reasoning_delta" : "text_delta",
              messageId: d.messageId,
              delta: d.delta,
            });
          },
        });
      } catch (e) {
        if (signal.aborted) return finish({ reason: "cancelled" });
        await hooks?.onError?.(e as Error, hookCtx);
        // Persist the failure AS the assistant message (not an empty/dropped
        // turn) so the transcript stays truthful and the UI can render an error
        // card with retry. The message carries no tool calls, so the transcript
        // stays settled.
        const errorText = (e as Error).message || "The model provider returned an error.";
        const errorMessage: ChatMessage = { id: messageId, role: "assistant", content: errorText, error: true };
        messages = [...messages, errorMessage];
        await io.saveMessages(messages);
        emit({ type: "message", message: errorMessage });
        return finish({ reason: "error", error: errorText });
      }
      if (signal.aborted) return finish({ reason: "cancelled" });
      runUsage = addUsage(runUsage, turn.usage);

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
        ...(reasoningBuf ? { reasoning: reasoningBuf } : {}),
        ...(toolCallRefs.length ? { toolCalls: toolCallRefs } : {}),
      };
      messages = [...messages, assistantMessage];
      contextMessages = [...contextMessages, assistantMessage];
      await io.saveMessages(messages);
      emit({ type: "message", message: assistantMessage });

      if (toolCallRefs.length === 0) {
        // Plugin hook: afterRun — plugins may inspect/modify the final response.
        await hooks?.afterRun?.({ text: turn.text, toolCalls: turn.toolCalls }, hookCtx);
        return finish({ reason: "completed" });
      }

      // ── Execute tool calls. Adjacent parallel-safe calls run CONCURRENTLY;
      // everything else runs one at a time exactly as it always did. Once the
      // assistant message is persisted, EVERY call gets an answer — execution,
      // in-band error, or "Cancelled by user." — before the loop can end. ──
      let cancelledMidTools = false;

      /** Run one call to a settled result string. Never throws. */
      const executeCall = async (call: TurnToolCall): Promise<CallOutcome> => {
        const tool = deps.tools[call.name];
        const decision = await hooks?.beforeToolCall?.(call, hookCtx);
        if (decision && decision.allow === false) {
          return { result: toolError(call.name, `blocked${decision.reason ? `: ${decision.reason}` : " by policy"}`) };
        }
        if (!tool) {
          return { result: toolError(call.name, "unknown tool", "use find_tools to discover available tools") };
        }
        if (tool.execution === "server") {
          let parsed: Record<string, unknown> = {};
          try {
            parsed = call.arguments ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
          } catch {
            /* leave {} — the tool reports its own validation error */
          }
          const serverOut = await runServerTool(
            tool,
            parsed,
            {
              signal,
              conversationId: deps.conversationId,
              agentId: deps.agentId,
              delegationDepth: deps.delegationDepth ?? 0,
              runId: deps.runId,
            },
            deps.toolTimeoutMs,
            (event) => emit({ type: "tool_progress", callId: call.id, event }),
            deps.awaitFrontendResult,
            emit,
          );
          return typeof serverOut === "string"
            ? { result: serverOut }
            : { result: serverOut.text, attachments: serverOut.attachments };
        }
        const outcome = await deps.awaitFrontendResult(call.id, deps.toolTimeoutMs);
        return {
          result:
            outcome.kind === "result"
              ? outcome.result
              : outcome.kind === "timeout"
                ? toolError(
                    call.name,
                    `no client executed the tool within ${Math.round(deps.toolTimeoutMs / 1000)}s`,
                    "the user's browser may be closed; the task can continue without this tool or be retried later",
                  )
                : CANCELLED_RESULT,
        };
      };

      for (const batch of batchToolCalls(turn.toolCalls, deps.tools, deps.maxParallelTools ?? DEFAULT_MAX_PARALLEL_TOOLS)) {
        // Outcomes in ORIGINAL batch order (Promise.all preserves index), consumed
        // by the persistence loop below. `settled` tracks which calls have already
        // emitted their terminal event so each gets EXACTLY ONE (tool_result or
        // tool_cancelled) — the de-dup rule (ADR-1 / S2): settle-time is the single
        // terminal-emission authority; the trailing loop only persists and must not
        // re-emit, or a cancelled call would surface two terminal events.
        const outcomes: CallOutcome[] = [];
        const settled = new Set<string>();

        if (cancelledMidTools || signal.aborted) {
          // A stop landed before this batch started: never start the calls. Each
          // gets its terminal cancel now (promptly, not held for the batch — FR-004)
          // and is persisted in the original-order loop below.
          cancelledMidTools = true;
          for (const call of batch) {
            settled.add(call.id);
            emit({ type: "tool_cancelled", callId: call.id });
            outcomes.push({ result: CANCELLED_RESULT });
          }
        } else {
          // Announce the whole batch before awaiting any of it: the browser
          // needs to see every frontend tool_call to dispatch them together,
          // and the UI shows them starting at once rather than trickling.
          for (const call of batch) {
            emit({
              type: "tool_call",
              callId: call.id,
              name: call.name,
              args: call.arguments,
              execution: deps.tools[call.name]?.execution ?? "frontend",
            });
          }
          // 045 US1 (ADR-1): emit each call's terminal event AS IT SETTLES — in
          // completion order, which is what flips the client cards individually —
          // decoupled from the persistence below (original call order, the
          // deterministic transcript). executeCall never throws, so allSettled
          // isn't needed — but a rejection here would strand a tool_use id with no
          // tool_result and wedge the next model turn, so map defensively PER CALL
          // (N1): an erroring call settles only ITSELF and never holds its
          // siblings' emissions (FR-008).
          outcomes.push(
            ...(await Promise.all(
              batch.map((call) =>
                executeCall(call)
                  .catch((e) => ({ result: toolError(call.name, (e as Error).message) }))
                  .then((outcome) => {
                    if (settled.has(call.id)) return outcome;
                    settled.add(call.id);
                    emit(
                      outcome.result === CANCELLED_RESULT
                        ? { type: "tool_cancelled", callId: call.id }
                        : { type: "tool_result", callId: call.id, result: outcome.result },
                    );
                    return outcome;
                  }),
              ),
            )),
          );
          if (signal.aborted) cancelledMidTools = true;
        }

        // Persist in the ORIGINAL call order, never completion order, so the
        // transcript is deterministic and a replay of the same run reads the same
        // way regardless of which tool happened to finish first (FR-002/FR-009).
        // The terminal tool_result/tool_cancelled events were ALREADY emitted at
        // settle above; this loop only persists the tool message, fires the
        // afterToolCall hook, and emits the `message` event (which is what reload
        // orders by). It MUST NOT re-emit a terminal event.
        for (let i = 0; i < batch.length; i++) {
          const call = batch[i];
          const { result, attachments } = outcomes[i];
          await hooks?.afterToolCall?.(call, result, hookCtx);
          const toolMessage: ChatMessage = {
            id: newMessageId(),
            role: "tool",
            content: result,
            toolCallId: call.id,
            ...(attachments?.length ? { attachments } : {}),
          };
          messages = [...messages, toolMessage];
          contextMessages = [...contextMessages, toolMessage];
          emit({ type: "message", message: toolMessage });
        }
        // One save per batch (a batch of 1 — every sequential tool — is exactly
        // the per-tool save this always did).
        await io.saveMessages(messages);
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
    await hooks?.onError?.(e as Error, hookCtx);
    return finish({ reason: "error", error: (e as Error).message });
  }
}
