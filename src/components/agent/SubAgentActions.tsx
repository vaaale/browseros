"use client";

import { useCopilotAction } from "@copilotkit/react-core";

// Lets the main agent create specialized sub-agents and delegate tasks to them.
export function SubAgentActions() {
  useCopilotAction({
    name: "listSubAgents",
    description: "List available sub-agents that tasks can be delegated to.",
    parameters: [],
    handler: async () => {
      const res = await fetch("/api/subagents").then((r) => r.json());
      return JSON.stringify(
        (res.subAgents ?? []).map((a: { id: string; name: string; description: string }) => ({
          id: a.id,
          name: a.name,
          description: a.description,
        })),
      );
    },
  });

  useCopilotAction({
    name: "createSubAgent",
    description:
      "Create a new specialized sub-agent with its own system prompt. Use this to spin up an expert for a recurring kind of task, then delegate to it.",
    parameters: [
      { name: "name", type: "string", description: "Sub-agent name", required: true },
      { name: "description", type: "string", description: "What this sub-agent is good at", required: true },
      { name: "systemPrompt", type: "string", description: "Instructions defining the sub-agent's behavior", required: true },
    ],
    handler: async ({ name, description, systemPrompt }) => {
      const res = await fetch("/api/subagents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, systemPrompt }),
      }).then((r) => r.json());
      return res.error ? `Error: ${res.error}` : `Created sub-agent "${res.subAgent.name}" (id: ${res.subAgent.id}).`;
    },
  });

  useCopilotAction({
    name: "delegateToSubAgent",
    description:
      "Delegate a task to a sub-agent by id or name. The sub-agent runs autonomously with file-system and web tools and returns its result. Prefer delegating self-contained subtasks.",
    parameters: [
      { name: "agent", type: "string", description: "Sub-agent id or name", required: true },
      { name: "task", type: "string", description: "The task to perform", required: true },
    ],
    handler: async ({ agent, task }) => {
      const res = await fetch("/api/subagents/delegate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent, task }),
      }).then((r) => r.json());
      if (res.error) return `Error: ${res.error}`;
      const r = res.result;
      const tools = r.toolCalls?.map((t: { tool: string }) => t.tool).join(", ") || "none";
      return `[${r.agent}] (${r.steps} steps, tools: ${tools})\n\n${r.output || r.error}`;
    },
  });

  return null;
}
