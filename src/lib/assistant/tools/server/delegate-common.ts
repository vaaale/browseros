import "server-only";
import type { ToolContext } from "../../tools";
import type { Agent } from "@/lib/agent/subagents/types";
import { getAgent } from "@/lib/agent/subagents/store";
import { getConversationActiveFeatureBranch } from "@/lib/agent/conversations-server";
import { runSubAgent } from "@/lib/agent/subagents/runner";
import { resolveStoreRoot, resolveAbsolutePath } from "@/lib/dev/spec-fs";
import { encodeNested } from "@/lib/agent/nested-events";
import { gateFor } from "../../gate";
import { runManager, type SurfaceAgentEntry } from "../../run-manager";
import { getMaxAgentSteps } from "@/lib/config/registry";
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
  specPath?: string,
): Promise<string> {
  if (def.type === "claude") {
    const featureBranch = await getConversationActiveFeatureBranch(ctx.conversationId).catch(() => undefined);
    if (!contentOnly && !featureBranch) {
      return `Error: ${toolName}: the Developer harness requires an active feature branch. Call dev_branch_request to set one up (it prompts the user for a name), then retry the delegation.`;
    }

    // contentOnly runs provision no worktree at all (see runClaudeAgent), so
    // nothing under a spec store is otherwise reachable by the Developer's own
    // filesystem tools — resolve `specPath` to a real absolute path HERE and
    // point the Developer at it, instead of making the delegating agent
    // distill the spec's content into `task` by hand (lossy, and duplicates
    // work the Developer would do again anyway by reading the spec itself).
    let effectiveTask = task;
    if (contentOnly && specPath) {
      try {
        // Both halves take the branch. Item-owned stores were excluded here on
        // the since-outdated belief that they "reject an explicit branch
        // context" — they route through it like every other writable store
        // (branchItemStoreRoot), and excluding them produced a base path for an
        // item whose only copy is on the branch. The lookup itself failed first:
        // `Unknown spec store "item-<id>"`, which is what a real session hit at
        // `implement` and then spent three turns working around by hand-writing
        // a host path into the task body.
        await resolveStoreRoot(specPath, featureBranch);
        const abs = await resolveAbsolutePath(specPath, featureBranch ? { branch: featureBranch } : undefined);
        effectiveTask = `${task}\n\n---\nSPEC: Before implementing, read the spec (and any sibling plan.md/design.md/tasks.md/mockup.html in the same directory) at: ${abs}`;
      } catch (e) {
        return `Error: ${toolName}: specPath "${specPath}" could not be resolved: ${(e as Error).message}`;
      }
    }

    const result = await runSubAgent(def, effectiveTask, {
      onEvent: (ev) => ctx.onEvent(ev),
      contentOnly,
      featureBranch,
      interactive: true,
      // 031-self-healing scope-add (ADR-11): a `type: "claude"` delegation is a
      // SEPARATE top-level run with its own spawned CLI child, and the local
      // runner does not forward `tool_progress` to its caller's onEvent — so
      // the delegating run's abort cannot reach this child on its own.
      // Recording the parentage is what makes Stop on the parent (e.g. a
      // self-heal build-studio run) also kill this Developer process instead of
      // orphaning it mid-edit.
      parentRunId: ctx.runId,
    });
    if (result.error && !result.output) return `Error: ${toolName}: ${result.error}`;
    const output = result.output || result.error || "";
    const summary = `[${result.agent} · ${result.type}] ${result.steps} step(s)\n\n${output}`;
    return (
      summary +
      encodeNested({
        // 045 US2 (S1): the claude/OpenCode harness is starts-only — it never
        // emits a per-tool tool_result (the CLI reports its final text once). So
        // the child entries carry `status: "done"` and NO per-child result; the
        // card renders them as done cards with no per-child Output.
        events: (result.toolCalls ?? []).map((t) => ({ tool: t.tool, input: t.input, status: "done" as const })),
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
    const composeSystem = ephemeralComposeSystem(
      def.systemPrompt,
      { skills: parentAgent?.skills, mcp: parentAgent?.mcp, kbs: parentAgent?.kbs },
      // 041-tool-groups: its OWN gate, not the parent's — a delegated agent must
      // be told about the tools it can actually call (FR-010/SC-011).
      { gate, tools: run.tools },
    );
    const maxSteps = await getMaxAgentSteps();
    return runLocalDelegation(run, ctx, "ephemeral", def.name, { systemPrompt: composeSystem, gate }, maxSteps, task);
  }

  const gate = await namedDelegationGate(def.id);
  const composeSystem = namedComposeSystem(def.id, { gate, tools: run.tools });
  const maxSteps = await getMaxAgentSteps();
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
  const composeSystem = surfaceComposeSystem(surfaceAgent.systemPrompt, { gate, tools: run.tools });
  const maxSteps = await getMaxAgentSteps();
  return runLocalDelegation(run, ctx, "surface", surfaceAgent.name, { systemPrompt: composeSystem, gate }, maxSteps, task);
}
