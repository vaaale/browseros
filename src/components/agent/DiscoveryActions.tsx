"use client";

import { useMemo } from "react";
import { useCopilotAction } from "@copilotkit/react-core";
import { fetchToolJson, runToolHandler } from "@/lib/agent/tool-kernel";

// Runtime discovery for the main-chat backend gate (025-deferred-tool-discovery).
// These actions are always registered; `/api/copilotkit` filters the model's
// visible tool schemas server-side and derives revealed tool ids from prior
// `find_tools` results in the transcript.

/** Shared handler for find_tools/find_agent — same endpoint, different `type`. */
function makeDiscoveryHandler(tool: string, type: "tool" | "agent", agentId: string) {
  return ({ query }: { query: string }) =>
    runToolHandler(tool, async ({ signal }) => {
      const q = String(query ?? "").trim();
      if (q.length < 2) return JSON.stringify([]);
      const out = await fetchToolJson(
        tool,
        `/api/assistant/discovery?agentId=${encodeURIComponent(agentId)}&query=${encodeURIComponent(q)}&type=${type}`,
        { signal },
      );
      if (!out.ok) return out.error;
      const res = out.data as { results?: unknown[]; error?: string };
      if (res.error) return `Error: ${res.error}`;
      return JSON.stringify(res.results ?? []);
    });
}

export function DiscoveryActions({
  agentId,
}: {
  agentId: string;
}) {
  const findToolsHandler = useMemo(() => makeDiscoveryHandler("find_tools", "tool", agentId), [agentId]);
  const findAgentHandler = useMemo(() => makeDiscoveryHandler("find_agent", "agent", agentId), [agentId]);

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
