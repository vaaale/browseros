import { NextRequest, NextResponse } from "next/server";
import {
  CAPABILITIES,
  deferredCapabilityIds,
  groupDescription,
  isActionId,
} from "@/lib/agent/capabilities-registry";
import { scoreCapability, scoreAgent } from "@/lib/agent/discovery-score";
import { getAgent, listSubAgents } from "@/lib/agent/subagents/store";
import { getMaxFindResults } from "@/lib/config/registry";
import { getToolSchema } from "@/lib/agent/subagents/tools";

export const dynamic = "force-dynamic";

// Runtime discovery for the CLIENT-side deferred gate (Phase A of the uniform
// agent behavior). Mirrors the server-side find_tools / find_agent tools:
//
//   GET /api/assistant/discovery?agentId=<id>&query=<q>&type=tool
//   GET /api/assistant/discovery?agentId=<id>&query=<q>&type=agent
//
// Filters candidates by the caller agent's effective deferred set (registry
// defaults ∪ agent.deferredTools) and its allowlist (empty ⇒ all), scores by
// the same deterministic scorer used server-side, and returns the top-N.
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const agentId = url.searchParams.get("agentId") || "";
  const query = (url.searchParams.get("query") ?? "").trim();
  const type = url.searchParams.get("type") === "agent" ? "agent" : "tool";

  if (!agentId) {
    return NextResponse.json({ error: "agentId is required" }, { status: 400 });
  }
  const agent = await getAgent(agentId);
  if (!agent) {
    return NextResponse.json({ error: `Agent "${agentId}" not found` }, { status: 404 });
  }

  const maxResults = await getMaxFindResults();

  if (query.length < 2) {
    return NextResponse.json({ results: [] });
  }

  if (type === "agent") {
    const agents = await listSubAgents();
    const scored = agents
      .map((a) => ({
        agent: a,
        score: scoreAgent({ name: a.name, description: a.description, type: a.type }, query),
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
    return NextResponse.json({
      results: scored.map(({ agent: a, score }) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        description: a.description,
        score,
      })),
    });
  }

  // type === "tool"
  const effectiveDeferred = new Set<string>([
    ...deferredCapabilityIds(),
    ...(agent.deferredTools ?? []),
  ]);
  const allow = agent.tools ?? [];
  const allowAll = allow.length === 0;
  const allowSet = new Set(allow);

  const scored = CAPABILITIES
    // Only main-chat actions are discoverable client-side — server-only
    // tools (context "tool") are unreachable from the browser.
    .filter((c) => isActionId(c.id))
    .filter((c) => effectiveDeferred.has(c.id))
    .filter((c) => allowAll || allowSet.has(c.id))
    .map((c) => ({ cap: c, score: scoreCapability(c, query, groupDescription(c.group)) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);

  return NextResponse.json({
    results: scored.map(({ cap, score }) => ({
      id: cap.id,
      group: cap.group,
      description: cap.description,
      schema: getToolSchema(cap.id) ?? { type: "object", properties: {} },
      score,
    })),
  });
}
