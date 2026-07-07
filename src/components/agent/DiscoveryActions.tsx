"use client";

import { useCallback } from "react";
import { useCopilotAction } from "@copilotkit/react-core";

// Runtime discovery for the main-chat backend gate (025-deferred-tool-discovery).
// These actions are always registered; `/api/copilotkit` filters the model's
// visible tool schemas server-side and derives revealed tool ids from prior
// `find_tools` results in the transcript.
export function DiscoveryActions({
  agentId,
}: {
  agentId: string;
}) {
  const findToolsHandler = useCallback(
    async ({ query }: { query: string }) => {
      const q = String(query ?? "").trim();
      if (q.length < 2) return JSON.stringify([]);
      const res = await fetch(
        `/api/assistant/discovery?agentId=${encodeURIComponent(agentId)}&query=${encodeURIComponent(q)}&type=tool`,
      ).then((r) => r.json()) as {
        results?: { id: string; group: string; description: string; schema: Record<string, unknown>; score: number }[];
        error?: string;
      };
      if (res.error) return `Error: ${res.error}`;
      return JSON.stringify(res.results ?? []);
    },
    [agentId],
  );

  const findAgentHandler = useCallback(
    async ({ query }: { query: string }) => {
      const q = String(query ?? "").trim();
      if (q.length < 2) return JSON.stringify([]);
      const res = await fetch(
        `/api/assistant/discovery?agentId=${encodeURIComponent(agentId)}&query=${encodeURIComponent(q)}&type=agent`,
      ).then((r) => r.json()) as {
        results?: { id: string; name: string; type: string; description: string; score: number }[];
        error?: string;
      };
      if (res.error) return `Error: ${res.error}`;
      return JSON.stringify(res.results ?? []);
    },
    [agentId],
  );

  useCopilotAction({
    name: "find_tools",
    description:
      "Discover deferred capabilities by natural-language query. Returns top-scoring deferred tools (id, group, description, JSON schema) that YOU are allowed to use; once returned, each becomes callable in the next step of this loop. Use this whenever a needed tool is not in your visible tools list.",
    parameters: [
      {
        name: "query",
        type: "string",
        description: "Natural-language description of the capability you need (min 2 chars).",
        required: true,
      },
    ],
    handler: findToolsHandler,
  });

  useCopilotAction({
    name: "find_agent",
    description:
      "Discover sub-agents you can delegate to by natural-language query. Returns each candidate agent's identity metadata (id, name, type, description) — never their internal tools list. Use before agent_delegate/dev_delegate when you don't already know which agent should handle a task.",
    parameters: [
      {
        name: "query",
        type: "string",
        description: "Natural-language description of the task or specialization you need (min 2 chars).",
        required: true,
      },
    ],
    handler: findAgentHandler,
  });

  return null;
}
