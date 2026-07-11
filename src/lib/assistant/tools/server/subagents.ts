import "server-only";
import type { AssistantTool } from "../../tools";
import { serverTool, schema, p } from "./util";
import { listSubAgents, getAgent, createSubAgent } from "@/lib/agent/subagents/store";
import { runSubAgent } from "@/lib/agent/subagents/runner";
import type { Agent } from "@/lib/agent/subagents/types";
import { getConversationActiveFeatureBranch } from "@/lib/agent/conversations-server";
import { encodeNested } from "@/lib/agent/nested-events";

// Delegation tools (ported from SubAgentActions.tsx): list/create agents and
// delegate a task. agent_delegate runs the sub-agent IN-PROCESS via runSubAgent,
// forwarding its live tool events to ctx.onEvent (nested-event cards + idle-
// timeout resets) and returning the same "[agent · type] N step(s)\n\n<output>"
// + encodeNested payload the old NDJSON handler produced, so tool cards render
// the nested event tree. The feature branch is resolved server-side from the
// conversation (never a model-visible parameter). Elicitations (dev_branch_request,
// agent_request_claude) stay frontend tools.

export function subAgentTools(): Record<string, AssistantTool> {
  return {
    agent_list: serverTool(
      "agent_list",
      "List available sub-agents (id, name, type local|claude, description) you can delegate to.",
      schema(),
      async () => {
        const agents = await listSubAgents();
        return JSON.stringify(agents.map((a) => ({ id: a.id, type: a.type, description: a.description })));
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
      "Delegate a task to a sub-agent. Provide an existing 'agent' id/name, OR an 'ephemeral' agent spec to create-and-run a one-off agent. Use a Claude agent (type 'claude') for ALL development tasks; Local otherwise.",
      schema(
        {
          agent: p.str("Existing sub-agent id/name (optional if ephemeral)"),
          task: p.str("The task to perform"),
          ephemeralName: p.str("For a one-off agent: its name"),
          ephemeralType: p.str("'local' or 'claude'"),
          ephemeralSystemPrompt: p.str("For a one-off agent: its instructions"),
          ephemeralSubagentType: p.str("For a one-off 'claude' agent: harness subagent_type (defaults to the name)"),
          contentOnly: p.bool(
            "Set true ONLY for standalone app content generation (e.g. a self-contained index.html or an iframe app project for app_build). Never for BrowserOS source analysis or implementation.",
          ),
        },
        ["task"],
      ),
      async (input, ctx) => {
        const task = String(input.task ?? "");
        if (!task) return "Error: agent_delegate: task is required.";

        let def: Agent | undefined;
        if (input.ephemeralName && input.ephemeralSystemPrompt) {
          const name = String(input.ephemeralName);
          def = {
            id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "ephemeral",
            name,
            description: "",
            type: input.ephemeralType === "claude" ? "claude" : "local",
            systemPrompt: String(input.ephemeralSystemPrompt),
            subagentType: input.ephemeralSubagentType ? String(input.ephemeralSubagentType) : undefined,
            ephemeral: true,
          };
        } else if (input.agent) {
          def = await getAgent(String(input.agent));
        }
        if (!def) return `Error: agent_delegate: no sub-agent "${input.agent}" and no ephemeral spec provided.`;

        const contentOnly = input.contentOnly === true;
        const featureBranch = await getConversationActiveFeatureBranch(ctx.conversationId).catch(() => undefined);
        if (def.type === "claude" && !contentOnly && !featureBranch) {
          return "Error: agent_delegate: the Developer harness requires an active feature branch. Call dev_branch_request to set one up (it prompts the user for a name), then retry the delegation.";
        }

        const result = await runSubAgent(def, task, {
          onEvent: (ev) => ctx.onEvent(ev),
          contentOnly,
          featureBranch,
          interactive: true,
        });
        if (result.error && !result.output) return `Error: agent_delegate: ${result.error}`;
        const output = result.output || result.error || "";
        const summary = `[${result.agent} · ${result.type}] ${result.steps} step(s)\n\n${output}`;
        return (
          summary +
          encodeNested({
            events: (result.toolCalls ?? []).map((t) => ({ tool: t.tool, input: t.input })),
            output,
          })
        );
      },
    ),
  };
}
