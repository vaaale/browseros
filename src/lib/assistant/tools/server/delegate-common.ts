import "server-only";
import type { ToolContext } from "../../tools";
import type { Agent } from "@/lib/agent/subagents/types";
import { getAgent } from "@/lib/agent/subagents/store";
import { getConversationActiveFeatureBranch } from "@/lib/agent/conversations-server";
import { runSubAgent } from "@/lib/agent/subagents/runner";
import { encodeNested } from "@/lib/agent/nested-events";
import { gateFor } from "../../gate";
import { runManager, type SurfaceAgentEntry } from "../../run-manager";
import { defaultMaxSteps } from "../../inner-loop";
import {
  namedDelegationGate,
  ephemeralDelegationGate,
  surfaceDelegationGate,
  namedComposeSystem,
  ephemeralComposeSystem,
  surfaceComposeSystem,
} from "../../delegation-gate";
import { runLocalDelegation } from "./delegate-local";

// Shared delegation branching (025-agent-delegation-v2), used by both
// agent_delegate and dev_delegate so the fixed-target Developer tool doesn't
// duplicate the claude/local split. `type: "claude"` (e.g. the seeded
// "developer" agent — development is ALWAYS done by Claude) is unaffected by
// this spec's registry unification (FR-024(a)) and continues exactly as
// today via runSubAgent/runClaudeAgent. `type: "local"` (named or ephemeral)
// runs through the new inner-loop path.

export async function delegateToAgent(
  def: Agent,
  isEphemeral: boolean,
  task: string,
  ctx: ToolContext,
  contentOnly: boolean,
  toolName: string,
): Promise<string> {
  if (def.type === "claude") {
    const featureBranch = await getConversationActiveFeatureBranch(ctx.conversationId).catch(() => undefined);
    if (!contentOnly && !featureBranch) {
      return `Error: ${toolName}: the Developer harness requires an active feature branch. Call dev_branch_request to set one up (it prompts the user for a name), then retry the delegation.`;
    }
    const result = await runSubAgent(def, task, {
      onEvent: (ev) => ctx.onEvent(ev),
      contentOnly,
      featureBranch,
      interactive: true,
    });
    if (result.error && !result.output) return `Error: ${toolName}: ${result.error}`;
    const output = result.output || result.error || "";
    const summary = `[${result.agent} · ${result.type}] ${result.steps} step(s)\n\n${output}`;
    return (
      summary +
      encodeNested({
        events: (result.toolCalls ?? []).map((t) => ({ tool: t.tool, input: t.input })),
        output,
      })
    );
  }

  const run = runManager().get(ctx.runId);
  if (!run) return `Error: ${toolName}: the parent run is no longer active.`;

  if (isEphemeral) {
    const parentGate = await gateFor(ctx.agentId);
    const gate = ephemeralDelegationGate(parentGate, run.tools);
    const parentAgent = await getAgent(ctx.agentId);
    const composeSystem = ephemeralComposeSystem(def.systemPrompt, {
      skills: parentAgent?.skills,
      mcp: parentAgent?.mcp,
    });
    const maxSteps = defaultMaxSteps(gate);
    return runLocalDelegation(run, ctx, "ephemeral", def.name, { systemPrompt: composeSystem, gate }, maxSteps, task);
  }

  const gate = await namedDelegationGate(def.id);
  const composeSystem = namedComposeSystem(def.id);
  const maxSteps = defaultMaxSteps(gate);
  return runLocalDelegation(run, ctx, "named", def.name, { systemPrompt: composeSystem, gate, model: def.model }, maxSteps, task);
}

/** Delegate to a window-scoped surface agent (025-agent-delegation-v2, US-4).
 *  Always `type: "local"` conceptually — a surface agent has no `type`/
 *  `model` field at all. Its Tier-2 tools (declared in `toolNames`) resolve
 *  and dispatch correctly because the inner loop shares this SAME run's
 *  `awaitFrontendResult` (FR-007, FR-011). */
export async function delegateToSurfaceAgent(
  surfaceAgent: SurfaceAgentEntry,
  task: string,
  ctx: ToolContext,
  toolName: string,
): Promise<string> {
  const run = runManager().get(ctx.runId);
  if (!run) return `Error: ${toolName}: the parent run is no longer active.`;

  const parentGate = await gateFor(ctx.agentId);
  const gate = surfaceDelegationGate(surfaceAgent.toolNames, parentGate);
  const composeSystem = surfaceComposeSystem(surfaceAgent.systemPrompt);
  const maxSteps = defaultMaxSteps(gate);
  return runLocalDelegation(run, ctx, "surface", surfaceAgent.name, { systemPrompt: composeSystem, gate }, maxSteps, task);
}
