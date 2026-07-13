import "server-only";
import type { ToolContext } from "../../tools";
import type { Run } from "../../run-manager";
import { runInnerLoop, checkDelegationDepth, type InnerLoopSpec } from "../../inner-loop";
import { encodeNested } from "@/lib/agent/nested-events";
import { logger } from "@/lib/logging";

// Shared `type: "local"` delegation path (025-agent-delegation-v2), used by
// both agent_delegate and dev_delegate: depth guard → runInnerLoop →
// lifecycle logging (FR-027) → the same
// "[agent · type] N step(s)\n\n<output>" + encodeNested() envelope the tool
// has always produced, so the nested-card renderer needs no changes.

export type DelegationKind = "named" | "ephemeral" | "surface";

export async function runLocalDelegation(
  run: Run,
  ctx: ToolContext,
  kind: DelegationKind,
  agentLabel: string,
  spec: InnerLoopSpec,
  maxSteps: number,
  task: string,
): Promise<string> {
  const depthCheck = checkDelegationDepth({
    conversationId: ctx.conversationId,
    agentId: ctx.agentId,
    delegationDepth: ctx.delegationDepth,
  });
  if (!depthCheck.ok) return `Error: agent_delegate: ${depthCheck.error}`;

  logger().log({
    level: "info",
    component: "assistant.delegate",
    conversation: ctx.conversationId,
    msg: "delegation started",
    data: { kind, agentId: agentLabel, depth: ctx.delegationDepth ?? 0, maxSteps },
  });

  const result = await runInnerLoop(run, ctx, spec, task, maxSteps);

  logger().log({
    level: result.reason === "error" ? "error" : "info",
    component: "assistant.delegate",
    conversation: ctx.conversationId,
    msg: `delegation finished: ${result.reason}`,
    data: { agentId: agentLabel, kind, steps: result.steps, reason: result.reason },
    ...(result.error ? { err: { message: result.error } } : {}),
  });

  if (result.error) return `Error: agent_delegate: ${result.error}`;
  const output = result.output;
  const summary = `[${agentLabel} · local] ${result.steps} step(s)\n\n${output}`;
  return summary + encodeNested({ events: result.toolCalls, output });
}
