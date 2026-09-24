import "server-only";
import { runAgentLoop, type AgentLoopIO, type StreamTurn } from "./agent-loop";
import type { ToolGateConfig, ToolContext } from "./tools";
import type { ChatMessage } from "./messages";
import type { RunEventInput } from "./run-events";
import { runManager, type Run } from "./run-manager";
import { streamModelTurn } from "./model-turn";
import { e2eScriptedTurn } from "./e2e-provider";
import { parseNested, type NestedEvent } from "@/lib/agent/nested-events";
import { logger } from "@/lib/logging";

// The shared delegation execution primitive (025-agent-delegation-v2). Every
// delegation kind (named, ephemeral, surface) runs through this — it is a
// SECOND invocation of runAgentLoop, not a new engine: blank in-memory
// transcript (FR-012), events reshaped into the legacy {tool,input} pair and
// forwarded via ctx.onEvent instead of the parent's SSE stream (FR-013), and
// the SAME parentRun's tools/awaitFrontendResult/toolTimeoutMs so Tier-2
// tools and Stop cascade for free (FR-007, FR-011).

export interface InnerLoopSpec {
  systemPrompt: () => Promise<string>;
  gate: ToolGateConfig;
  /** Named-agent model override only (FR-015). Undefined for ephemeral/surface. */
  model?: string;
}

export interface InnerLoopResult {
  output: string;
  error?: string;
  steps: number;
  /** The inner loop's own tool STARTS ({ tool, input }) — the legacy shape the
   *  claude/OpenCode path (starts-only, S1) still encodes via this field. */
  toolCalls: { tool: string; input: unknown }[];
  /** 045 US2 (ADR-3 / B1): the FULL per-child terminal list, in original inner
   *  call order. Each entry carries the child's settled `result?`/`status?` and
   *  its own `nested?` child list (when the child is itself a delegation). The
   *  local path encodes THIS (not just the starts) so a done delegation's
   *  child-card tree rebuilds from the persisted string after a reload. */
  results: NestedEvent[];
  /** The underlying runAgentLoop outcome — kept precise (not reverse-derived
   *  from `output`/`error`) so callers can log an exact "delegation finished:
   *  <reason>" record (FR-027) without guesswork. */
  reason: "completed" | "max_steps" | "cancelled" | "error";
}

/** Build Studio → Developer is one level of nesting; guard against more,
 *  uniformly across named/ephemeral/surface delegation (FR-024(b)) — this
 *  generalizes today's MAX_DELEGATE_DEPTH, which was checked only inside the
 *  `dev_delegate` tool call site. */
export const MAX_DELEGATE_DEPTH = 2;


/** Depth-guard check (FR-024(b)). Callers pass the CURRENT ctx's
 *  `delegationDepth` (0 for a top-level call); `runInnerLoop` itself
 *  increments it by one for the nested invocation. Logs the rejection
 *  (FR-027) — today's legacy guard logs nothing at all. */
export function checkDelegationDepth(ctx: {
  conversationId: string;
  agentId: string;
  delegationDepth?: number;
}): { ok: true } | { ok: false; error: string } {
  const depth = ctx.delegationDepth ?? 0;
  if (depth >= MAX_DELEGATE_DEPTH) {
    logger().log({
      level: "warn",
      component: "assistant.delegate",
      conversation: ctx.conversationId,
      msg: "delegation depth limit reached",
      data: {
        conversationId: ctx.conversationId,
        agentId: ctx.agentId,
        depth,
      },
    });
    return { ok: false, error: "Delegation depth limit reached; cannot nest another delegation." };
  }
  return { ok: true };
}

/** Run a delegation as an inner loop. `ctx` is the delegating tool call's OWN
 *  ToolContext (its `signal` is already scoped to this call's lifetime, per
 *  agent-loop.ts's linked-abort fix, and its `onEvent` is the SSE
 *  tool_progress conduit for this call). */
export async function runInnerLoop(
  parentRun: Run,
  ctx: ToolContext,
  spec: InnerLoopSpec,
  task: string,
  maxSteps: number,
): Promise<InnerLoopResult> {
  const manager = runManager();

  let messages: ChatMessage[] = [];
  const io: AgentLoopIO = {
    loadMessages: async () => [],
    saveMessages: async (m) => {
      messages = m;
    },
  };

  let steps = 0;
  const toolCalls: { tool: string; input: unknown }[] = [];
  // 045 US2 (B1): per inner callId, the settled result + status. Map insertion
  // order is the inner call order — the original order the terminal payload must
  // keep (FR-002/FR-009 applied one level down).
  const innerCalls = new Map<string, { tool: string; input?: unknown; result?: string; status?: "running" | "done" | "cancelled" }>();
  // Tracks which in-flight callIds belong to a FRONTEND-execution tool, so
  // the matching tool_result/tool_cancelled can also be forwarded (below).
  const frontendCallIds = new Set<string>();
  const emit = (e: RunEventInput): void => {
    if (e.type === "step_started") {
      steps = e.step + 1;
      return;
    }
    if (e.type === "tool_call") {
      let input: unknown;
      try {
        input = e.args ? JSON.parse(e.args) : {};
      } catch {
        input = e.args;
      }
      // 045 US2: carry the INNER callId so the card's live projection can match a
      // nested result/cancel to its start exactly (not by tool name alone).
      const entry = { tool: e.name, input, callId: e.callId };
      toolCalls.push(entry);
      innerCalls.set(e.callId, { tool: e.name, input, status: "running" });
      ctx.onEvent(entry); // informational nested-progress entry (FR-013)

      // A FRONTEND-execution tool (e.g. a surface agent's own Tier-2 tools,
      // FR-007) needs the browser to actually see this call to dispatch it —
      // dispatchFrontendCall (run-client.ts) only reacts to a REAL tool_call
      // event on the run's live stream, not the informational entry above.
      // manager.emit() only appends to the run's ephemeral event log — it
      // does NOT persist a message, so this does not violate FR-014 (the
      // persisted transcript still gains only the outer delegation's one
      // tool_call/tool_result, written separately by delegate-common.ts).
      if (parentRun.tools[e.name]?.execution === "frontend") {
        frontendCallIds.add(e.callId);
        manager.emit(parentRun, e);
      }
      return;
    }
    if (e.type === "tool_result" || e.type === "tool_cancelled") {
      const inner = innerCalls.get(e.callId);
      if (inner) {
        if (e.type === "tool_result") {
          inner.result = e.result;
          inner.status = "done";
          // 045 US2 (FR-005): forward the nested RESULT live through the
          // per-call tool_progress channel (ctx.onEvent → the parent card's
          // progress[]), so a running delegation streams nested completions —
          // not only nested starts. No new run-event type: this rides the
          // existing tool_progress conduit (ADR-3).
          ctx.onEvent({ tool: inner.tool, type: "tool_result", callId: e.callId, result: e.result });
        } else {
          inner.status = "cancelled";
          ctx.onEvent({ tool: inner.tool, type: "tool_cancelled", callId: e.callId });
        }
      }
      // (unchanged) a frontend-exec inner call ALSO gets a REAL event on the
      // parent run so the browser dispatches/handles it.
      if (frontendCallIds.has(e.callId)) {
        manager.emit(parentRun, e);
      }
    }
  };

  // e2e scripting (Current-state audit): an `@@e2e {"turns":[...]}` string
  // passed as `task` scripts THIS inner loop's own model turns, independently
  // of whatever provider the outer run is using — same pattern start-run.ts
  // already uses with the primary run's message.
  const baseStreamTurn = e2eScriptedTurn(task) ?? streamModelTurn;
  const streamTurn: StreamTurn = (opts) => baseStreamTurn({ ...opts, model: spec.model });

  const result = await runAgentLoop(
    {
      runId: parentRun.id,
      conversationId: parentRun.conversationId,
      agentId: parentRun.agentId,
      signal: ctx.signal,
      emit,
      streamTurn,
      composeSystem: spec.systemPrompt,
      tools: parentRun.tools,
      gate: spec.gate,
      io,
      awaitFrontendResult: (callId, ms) => manager.awaitFrontendResult(parentRun, callId, ms),
      maxSteps,
      toolTimeoutMs: parentRun.toolTimeoutMs,
      delegationDepth: (ctx.delegationDepth ?? 0) + 1,
    },
    { userMessage: { content: task } },
  );

  // 045 US2 (B1): build the full per-child terminal list in original inner call
  // order. A child that is itself a delegation carries its own encodeNested
  // result; resolve it into this child's nested list (recursion by structure).
  const results: NestedEvent[] = [...innerCalls.values()].map((c) => {
    const ev: NestedEvent = { tool: c.tool };
    if (c.input !== undefined) ev.input = c.input;
    if (c.result !== undefined) ev.result = c.result;
    if (c.status !== undefined) ev.status = c.status;
    if (c.result) {
      const parsed = parseNested(c.result);
      if (parsed) ev.nested = parsed.events;
    }
    return ev;
  });

  if (result.reason === "error") {
    return { output: "", error: result.error ?? "unknown error", steps, toolCalls, results, reason: "error" };
  }
  if (result.reason === "cancelled") {
    return { output: "Delegation cancelled.", steps, toolCalls, results, reason: "cancelled" };
  }
  // "completed" or "max_steps": runAgentLoop already appended the right final
  // assistant message (the model's own answer, or STEP_LIMIT_TEXT) — read it
  // back verbatim rather than reconstructing either string ourselves.
  const last = [...messages].reverse().find((m) => m.role === "assistant");
  return { output: last?.content ?? "", steps, toolCalls, results, reason: result.reason };
}
