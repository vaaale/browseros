import { NextRequest, NextResponse } from "next/server";
import { listSubAgents, createSubAgent, deleteSubAgent, ProtectedAgentError } from "@/lib/agent/subagents/store";
import type { Agent, AgentType } from "@/lib/agent/subagents/types";
import { CAPABILITIES } from "@/lib/agent/capabilities-registry";
import { unresolvedToolIds } from "@/lib/assistant/gate";

export const dynamic = "force-dynamic";

// 025-agent-delegation-v2 (FR-023): surface each agent's unresolved tool ids
// (e.g. a typo, or a stale pre-016 id) computed at read time — not stored —
// so the existing Settings → Agents editor can flag them without a new page.
function withUnresolvedToolIds(agents: Agent[]): (Agent & { unresolvedToolIds: string[] })[] {
  const registryIds = new Set(CAPABILITIES.map((c) => c.id));
  return agents.map((a) => ({
    ...a,
    unresolvedToolIds: [...unresolvedToolIds(a.tools, registryIds), ...unresolvedToolIds(a.deferredTools, registryIds)],
  }));
}

export async function GET() {
  return NextResponse.json({ subAgents: withUnresolvedToolIds(await listSubAgents()) });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body.name || !body.systemPrompt) {
      return NextResponse.json({ error: "name and systemPrompt are required" }, { status: 400 });
    }
    const agent = await createSubAgent({
      name: String(body.name),
      description: String(body.description ?? ""),
      type: body.type === "claude" ? "claude" : ("local" as AgentType),
      systemPrompt: String(body.systemPrompt),
      tools: Array.isArray(body.tools) ? body.tools.map(String) : undefined,
      model: body.model ? String(body.model) : undefined,
      subagentType: body.subagentType ? String(body.subagentType) : undefined,
    });
    return NextResponse.json({ subAgent: agent });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id query param required" }, { status: 400 });
  try {
    await deleteSubAgent(id);
  } catch (err) {
    if (err instanceof ProtectedAgentError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
  return NextResponse.json({ subAgents: withUnresolvedToolIds(await listSubAgents()) });
}
