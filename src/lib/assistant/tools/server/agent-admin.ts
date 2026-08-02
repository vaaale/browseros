import "server-only";
import type { AssistantTool } from "../../tools";
import { serverTool, schema, p } from "./util";
import { getAgent, setAgentSystemPrompt } from "@/lib/agent/subagents/store";

// The two agent self-editing tools (ported from DevActions.tsx): read/rewrite
// THIS conversation's agent's editable personality (its base systemPrompt). The
// composed prompt (core policy + memory + skills) is added at runtime and must
// never be written back — agent_prompt_get returns only the editable text.
// Plus agent_definition_get: read-only introspection of an ARBITRARY OTHER
// named agent, for a reviewer auditing a different agent's live prompt.

export function agentAdminTools(): Record<string, AssistantTool> {
  return {
    agent_prompt_get: serverTool(
      "agent_prompt_get",
      "Read THIS conversation's agent's EDITABLE base instructions (its personality) — the exact text agent_prompt_set overwrites. This is NOT the fully composed prompt: the always-injected core policy, memory, and skills index are added at runtime and MUST NOT be edited or written back.",
      schema(),
      async (_input, ctx) => {
        const agent = await getAgent(ctx.agentId);
        if (!agent) return "No agent is associated with this conversation.";
        return String(agent.systemPrompt ?? "");
      },
    ),

    agent_prompt_set: serverTool(
      "agent_prompt_set",
      "Rewrite THIS conversation's agent's base instructions (personality) to improve future behavior. Use sparingly and preserve important existing guidance.",
      schema({ instructions: p.str("The new agent personality instructions") }, ["instructions"]),
      async (input, ctx) => {
        if (!ctx.agentId) return "No agent is associated with this conversation.";
        await setAgentSystemPrompt(ctx.agentId, String(input.instructions ?? ""));
        return "Updated this conversation's agent. It takes effect in the next chat session.";
      },
    ),

    // Read-only introspection of an ARBITRARY named agent — for a reviewer
    // auditing a DIFFERENT agent's live behavior-governing prompt, not the
    // calling conversation's own. Deliberately has no write counterpart:
    // agent_prompt_set above only ever edits the caller's own agent, and
    // there is no tool anywhere that writes another agent's definition — a
    // reviewer using this tool can inspect, never modify, what it finds.
    agent_definition_get: serverTool(
      "agent_definition_get",
      "Read ANY named agent's current live definition (id, type, description, tools, skills, systemPrompt) from data/agents/<id>/AGENT.md — for auditing what an agent's actual current prompt says, not just the calling conversation's own agent. Read-only: there is no tool to write another agent's definition.",
      schema({ agentId: p.str('The agent id or name to look up, e.g. "build-studio", "architect".') }, ["agentId"]),
      async (input) => {
        const id = String(input.agentId ?? "").trim();
        if (!id) return "No agentId provided.";
        const agent = await getAgent(id);
        if (!agent) return `No agent named "${id}" found in data/agents.`;
        return JSON.stringify(
          {
            id: agent.id,
            name: agent.name,
            description: agent.description,
            type: agent.type,
            tools: agent.tools ?? [],
            skills: agent.skills ?? [],
            useDefaultPrompt: agent.useDefaultPrompt ?? true,
            systemPrompt: agent.systemPrompt,
          },
          null,
          2,
        );
      },
    ),
  };
}
