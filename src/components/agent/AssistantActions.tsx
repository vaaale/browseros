"use client";

import { useCopilotAction } from "@copilotkit/react-core";

// Lets the assistant switch which agent's instructions it uses as its active
// personality. (Use listSubAgents to see the available agents.)
export function AssistantActions() {
  useCopilotAction({
    name: "switchAssistantAgent",
    description:
      "Switch the main assistant's active agent (its personality) by agent id. The agents are the same ones listed by listSubAgents. Takes effect on the next message.",
    parameters: [{ name: "id", type: "string", description: "Agent id", required: true }],
    handler: async ({ id }) => {
      const res = await fetch("/api/assistant/agent", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: id }),
      }).then((r) => r.json());
      return res.error ? `Error: ${res.error}` : `Active assistant agent is now "${res.active}".`;
    },
  });

  return null;
}
