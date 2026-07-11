import "server-only";
import type { AssistantTool } from "../../tools";
import { serverTool, schema, p } from "./util";
import { getAgent, setAgentSystemPrompt } from "@/lib/agent/subagents/store";

// The two agent self-editing tools (ported from DevActions.tsx): read/rewrite
// THIS conversation's agent's editable personality (its base systemPrompt). The
// composed prompt (core policy + memory + skills) is added at runtime and must
// never be written back — agent_prompt_get returns only the editable text.

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
  };
}
