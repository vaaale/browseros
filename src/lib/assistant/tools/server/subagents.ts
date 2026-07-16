import "server-only";
import type { AssistantTool } from "../../tools";
import { serverTool, schema, p } from "./util";
import { listSubAgents, getAgent, createSubAgent } from "@/lib/agent/subagents/store";
import type { Agent } from "@/lib/agent/subagents/types";
import { runManager } from "../../run-manager";
import { delegateToAgent, delegateToSurfaceAgent } from "./delegate-common";

// Delegation tools (ported from SubAgentActions.tsx): list/create agents and
// delegate a task. agent_delegate's branching (type: "claude" via runSubAgent,
// unaffected by 025-agent-delegation-v2 per FR-024(a); type: "local" — named
// or ephemeral — via the new inner-loop path; window-scoped surface agents,
// US-4) lives in delegate-common.ts, shared with dev_delegate
// (delegate-common.ts / dev-delegate.ts). The feature branch is resolved
// server-side from the conversation (never a model-visible parameter).
// Elicitations (dev_branch_request, agent_request_claude) stay frontend tools.

export function subAgentTools(): Record<string, AssistantTool> {
  return {
    agent_list: serverTool(
      "agent_list",
      "List available agents (id, name, type local|claude, description, scope) you can delegate to, including window-scoped surface agents from currently-open app windows.",
      schema(),
      async (_input, ctx) => {
        const run = runManager().get(ctx.runId);
        const persisted = (await listSubAgents()).map((a) => ({
          id: a.id,
          type: a.type as string,
          description: a.description,
          scope: "persisted" as const,
        }));
        const surface = [...(run?.agents.values() ?? [])].map((a) => ({
          id: a.id,
          type: "local",
          description: a.description,
          scope: "surface" as const,
        }));
        return JSON.stringify([...persisted, ...surface]);
      },
    ),

    agent_create: serverTool(
      "agent_create",
      "Create a reusable sub-agent. type must be 'claude' for development/coding agents, otherwise 'local'. Persisted as markdown under data/agents.",
      schema(
        {
          name: p.str("Sub-agent name"),
          description: p.str("What it is good at"),
          type: p.str("'local' or 'claude'"),
          systemPrompt: p.str("Instructions defining the sub-agent"),
          subagentType: p.str("For 'claude' agents: the harness Agent subagent_type to use. Defaults to the agent id."),
        },
        ["name", "description", "type", "systemPrompt"],
      ),
      async (input) => {
        const sa = await createSubAgent({
          name: String(input.name ?? ""),
          description: String(input.description ?? ""),
          type: input.type === "claude" ? "claude" : "local",
          systemPrompt: String(input.systemPrompt ?? ""),
          subagentType: input.subagentType ? String(input.subagentType) : undefined,
        });
        return `Created ${sa.type} sub-agent "${sa.name}" (${sa.id}).`;
      },
    ),

    agent_delegate: serverTool(
      "agent_delegate",
      "Delegate a task to a named or one-off (ephemeral) agent.\n\nNAMED — supply `agent` with an existing id/name (persisted or surface). Use find_agent to discover options.\n\nEPHEMERAL — supply all three of `ephemeralName` + `ephemeralType` + `ephemeralSystemPrompt` (all three are required; omitting any one fails). Choose the type:\n• `ephemeralType: 'local'` — for research, analysis, writing, or any non-BOS-development task. No feature branch needed.\n• `ephemeralType: 'claude'` — ONLY for BOS source-code development. Requires an active feature branch; call dev_branch_request first if none is set.",
      schema(
        {
          agent: p.str("Existing agent id/name — persisted or a currently-registered surface agent (optional if ephemeral)"),
          task: p.str("The task to perform"),
          ephemeralName: p.str("One-off agent display name. MUST be combined with ephemeralType and ephemeralSystemPrompt — all three are required for ephemeral mode."),
          ephemeralType: p.str("'local' for research, analysis, writing, or any non-development task (no feature branch needed). 'claude' ONLY for BOS source-code development (requires an active feature branch; call dev_branch_request first if none is set)."),
          ephemeralSystemPrompt: p.str("REQUIRED when ephemeralName is set — the system instructions defining the agent's role and scope. Omitting this while providing ephemeralName will fail."),
          ephemeralSubagentType: p.str("For 'claude' ephemeral agents only: the Claude Code harness subagent_type (defaults to the agent name). Not applicable to 'local' agents."),
          contentOnly: p.bool(
            "Set true when the 'claude' agent should produce content or perform analysis without touching BOS source files (bypasses the feature branch requirement). Set false (default) when the agent needs full BOS source access for implementation.",
          ),
        },
        ["task"],
      ),
      async (input, ctx) => {
        const task = String(input.task ?? "");
        if (!task) return "Error: agent_delegate: task is required.";
        const contentOnly = input.contentOnly === true;

        if (input.ephemeralName && !input.ephemeralSystemPrompt) {
          return "Error: agent_delegate: ephemeralSystemPrompt is required when ephemeralName is set — provide the agent's system instructions.";
        }

        if (input.ephemeralName && input.ephemeralSystemPrompt) {
          const name = String(input.ephemeralName);
          const def: Agent = {
            id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "ephemeral",
            name,
            description: "",
            type: input.ephemeralType === "claude" ? "claude" : "local",
            systemPrompt: String(input.ephemeralSystemPrompt),
            subagentType: input.ephemeralSubagentType ? String(input.ephemeralSubagentType) : undefined,
            ephemeral: true,
          };
          return delegateToAgent(def, true, task, ctx, contentOnly, "agent_delegate");
        }

        if (input.agent) {
          const idOrName = String(input.agent);
          // Resolution order (FR-022): the persisted roster ALWAYS wins over
          // a surface agent — a surface agent may never shadow a persisted one.
          const named = await getAgent(idOrName);
          if (named) return delegateToAgent(named, false, task, ctx, contentOnly, "agent_delegate");

          const run = runManager().get(ctx.runId);
          const surfaceAgent = run?.agents.get(idOrName.toLowerCase());
          if (surfaceAgent) return delegateToSurfaceAgent(surfaceAgent, task, ctx, "agent_delegate");
        }

        return `Error: agent_delegate: no matching agent found${input.agent ? ` for "${input.agent}"` : ""} and no ephemeral spec provided. Supply either an existing \`agent\` id/name, or all three of \`ephemeralName\` + \`ephemeralType\` + \`ephemeralSystemPrompt\`.`;
      },
    ),
  };
}
