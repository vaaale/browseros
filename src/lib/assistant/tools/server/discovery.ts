import "server-only";
import type { AssistantTool } from "../../tools";
import { serverTool, schema, p } from "./util";
import { CAPABILITIES, groupDescription } from "@/lib/agent/capabilities-registry";
import { scoreCapability, scoreAgent } from "@/lib/agent/discovery-score";
import { listSubAgents } from "@/lib/agent/subagents/store";
import { getMaxFindResults } from "@/lib/config/registry";
import { gateFor } from "../../gate";

// Runtime tool/agent discovery (025), ported from DiscoveryActions.tsx. These
// are ALWAYS-available (not registry-gated). find_tools returns a JSON ARRAY of
// { id, … } objects — the v2 loop derives the "revealed" deferred set from
// exactly this shape in the transcript (src/lib/assistant/messages.ts
// deriveRevealedIds), so a discovered tool becomes callable on the next step
// with no explicit reveal callback.
//
// `lookup` resolves each capability's live JSON schema from the assembled
// registry (passed in by registry.ts to avoid an import cycle).
export function discoveryTools(lookup: (id: string) => AssistantTool | undefined): Record<string, AssistantTool> {
  return {
    find_tools: serverTool(
      "find_tools",
      "Discover deferred capabilities by natural-language query. Returns top-scoring deferred tools (id, group, description, JSON schema) that YOU are allowed to use; once returned, each becomes callable in the next step of this run. Use this whenever a needed tool is not in your visible tools list.",
      schema({ query: p.str("Natural-language description of the capability you need (min 2 chars).") }, ["query"]),
      async (input, ctx) => {
        const query = String(input.query ?? "").trim();
        if (query.length < 2) return JSON.stringify([]);
        const [gate, maxResults] = await Promise.all([gateFor(ctx.agentId), getMaxFindResults()]);
        const scored = CAPABILITIES
          .filter((c) => gate.deferred.has(c.id) && gate.allow.has(c.id) && lookup(c.id) !== undefined)
          .map((c) => ({ cap: c, score: scoreCapability(c, query, groupDescription(c.group)) }))
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, maxResults);
        const results = scored.map(({ cap, score }) => {
          const tool = lookup(cap.id)!;
          return { id: cap.id, group: cap.group, description: tool.description, schema: tool.parameters, score };
        });
        return JSON.stringify(results);
      },
    ),

    find_agent: serverTool(
      "find_agent",
      "Discover sub-agents you can delegate to by natural-language query. Returns each candidate agent's identity metadata (id, name, type, description) — never their internal tools list. Use before agent_delegate when you don't already know which agent should handle a task.",
      schema({ query: p.str("Natural-language description of the task or specialization you need (min 2 chars).") }, ["query"]),
      async (input) => {
        const query = String(input.query ?? "").trim();
        if (query.length < 2) return JSON.stringify([]);
        const maxResults = await getMaxFindResults();
        const agents = await listSubAgents();
        const scored = agents
          .map((a) => ({ agent: a, score: scoreAgent({ name: a.name, description: a.description, type: a.type }, query) }))
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, maxResults);
        return JSON.stringify(scored.map(({ agent, score }) => ({ id: agent.id, name: agent.name, type: agent.type, description: agent.description, score })));
      },
    ),
  };
}
