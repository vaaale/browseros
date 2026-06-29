import { NextRequest, NextResponse } from "next/server";
import {
  listSubAgents,
  getActiveAgentId,
  setActiveAgentId,
  setAgentSystemPrompt,
  setAgentCapabilities,
  createSubAgent,
} from "@/lib/agent/subagents/store";
import { composeInstructions } from "@/lib/agent/instructions";
import { listSkills } from "@/lib/agent/skills/store";
import { listMcpServers } from "@/lib/mcp/store";
import { CAPABILITIES } from "@/lib/agent/capabilities-registry";

export const dynamic = "force-dynamic";

// The catalog of capabilities the Settings UI offers per agent. `tools` is the
// unified capability registry (016): one allowlist governs an agent in both
// contexts — server tools (toolsFor) and main-chat actions (gated client-side via
// AgentCapabilities). Each item is { id, group, description, context }.
async function buildCatalog() {
  const [skills, mcp] = await Promise.all([listSkills(), listMcpServers()]);
  return {
    // The unified capability registry (016): one allowlist governs an agent in both
    // contexts. Each item is { id, group, description, context }.
    tools: CAPABILITIES,
    skills: skills.map((s) => ({ id: s.id, name: s.name })),
    mcp: mcp.map((m) => ({
      name: m.name,
      endpoint: m.endpoint || [m.command, ...(m.args ?? [])].filter(Boolean).join(" "),
    })),
  };
}

// The main assistant's personality is the "active agent" — one of the agents in
// data/agents. (There is no separate "profile" concept.)
export async function GET(req: NextRequest) {
  // ?agentId composes instructions for a specific agent (embedded chats, 012);
  // otherwise the globally active agent.
  const agentId = new URL(req.url).searchParams.get("agentId") || undefined;
  const [agents, active, composed, catalog] = await Promise.all([
    listSubAgents(),
    getActiveAgentId(),
    composeInstructions(agentId),
    buildCatalog(),
  ]);
  const activeAgent = agents.find((a) => a.id === active);
  return NextResponse.json({
    agents: agents.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      type: a.type,
      tools: a.tools ?? [],
      skills: a.skills ?? [],
      mcp: a.mcp ?? [],
    })),
    active,
    activeBody: activeAgent?.systemPrompt ?? "",
    composed,
    catalog,
  });
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    if (typeof body.active === "string") await setActiveAgentId(body.active);
    if (typeof body.body === "string") await setAgentSystemPrompt(await getActiveAgentId(), body.body);
    if (typeof body.agentId === "string" && (body.tools || body.skills || body.mcp)) {
      await setAgentCapabilities(body.agentId, {
        tools: Array.isArray(body.tools) ? body.tools.map(String) : undefined,
        skills: Array.isArray(body.skills) ? body.skills.map(String) : undefined,
        mcp: Array.isArray(body.mcp) ? body.mcp.map(String) : undefined,
      });
    }
    return NextResponse.json({ active: await getActiveAgentId() });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body.name || !body.body) return NextResponse.json({ error: "name and body are required" }, { status: 400 });
    const agent = await createSubAgent({
      name: String(body.name),
      description: String(body.description ?? ""),
      type: "local",
      systemPrompt: String(body.body),
    });
    return NextResponse.json({ agent });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
