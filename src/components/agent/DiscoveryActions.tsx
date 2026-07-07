"use client";

import { useCopilotAction } from "@copilotkit/react-core";
import { addRevealed } from "@/lib/agent/revealed-store";

// Client-side runtime discovery for the main-chat gate (025-deferred-tool-
// discovery). These two actions are registered with the RAW CopilotKit hook
// (not the gated shim) so they are ALWAYS available to the model regardless of
// the active agent's allowlist — an agent that has no visible tools can still
// discover deferred ones.
//
// On a successful find_tools call, discovered ids are added to the per-
// conversation revealed set (revealed-store), and gated-action.ts re-renders
// those actions with `available: true` in the next step.
export function DiscoveryActions({
  agentId,
  conversationId,
}: {
  agentId: string;
  conversationId: string;
}) {
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
    handler: async ({ query }) => {
      const q = String(query ?? "").trim();
      if (q.length < 2) return JSON.stringify([]);
      const res = await fetch(
        `/api/assistant/discovery?agentId=${encodeURIComponent(agentId)}&query=${encodeURIComponent(q)}&type=tool`,
      ).then((r) => r.json()) as {
        results?: { id: string; group: string; description: string; schema: Record<string, unknown>; score: number }[];
        error?: string;
      };
      if (res.error) return `Error: ${res.error}`;
      const results = res.results ?? [];
      if (results.length && conversationId) {
        addRevealed(conversationId, results.map((r) => r.id));
      }
      return JSON.stringify(results);
    },
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
    handler: async ({ query }) => {
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
  });

  return null;
}
