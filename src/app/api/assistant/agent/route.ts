import { NextRequest, NextResponse } from "next/server";
import {
  listSubAgents,
  setAgentSystemPrompt,
  setAgentCapabilities,
  setAgentUseDefaultPrompt,
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
    skills: skills.map((s) => ({ id: s.id, name: s.name, description: s.description ?? "" })),
    mcp: mcp.map((m) => ({
      name: m.name,
      description: m.description ?? "",
      endpoint: m.endpoint || [m.command, ...(m.args ?? [])].filter(Boolean).join(" "),
    })),
  };
}

// Agents live in data/agents. There is no global "active agent" — each
// conversation carries its own. `?agentId` composes that specific agent's
// instructions (for debugging/preview); omitted → no `composed` is returned.
export async function GET(req: NextRequest) {
  const agentId = new URL(req.url).searchParams.get("agentId") || "";
  const [agents, composed, catalog] = await Promise.all([
    listSubAgents(),
    agentId ? composeInstructions(agentId) : Promise.resolve(undefined),
    buildCatalog(),
  ]);
  return NextResponse.json({
    agents: agents.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      type: a.type,
      tools: a.tools ?? [],
      skills: a.skills ?? [],
      mcp: a.mcp ?? [],
      systemPrompt: a.systemPrompt ?? "",
      useDefaultPrompt: a.useDefaultPrompt ?? true,
    })),
    composed,
    catalog,
  });
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    // Editing an agent always targets an explicit agent id (the Settings details
    // pane / capability picker). No implicit "active agent" target.
    if (typeof body.agentId !== "string" || !body.agentId) {
      return NextResponse.json({ error: "agentId is required" }, { status: 400 });
    }
    if (typeof body.body === "string") {
      await setAgentSystemPrompt(body.agentId, body.body);
    }
    if (body.tools || body.skills || body.mcp) {
      await setAgentCapabilities(body.agentId, {
        tools: Array.isArray(body.tools) ? body.tools.map(String) : undefined,
        skills: Array.isArray(body.skills) ? body.skills.map(String) : undefined,
        mcp: Array.isArray(body.mcp) ? body.mcp.map(String) : undefined,
      });
    }
    if (typeof body.useDefaultPrompt === "boolean") {
      await setAgentUseDefaultPrompt(body.agentId, body.useDefaultPrompt);
    }
    return NextResponse.json({ ok: true });
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
