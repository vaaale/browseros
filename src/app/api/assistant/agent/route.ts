import { NextRequest, NextResponse } from "next/server";
import {
  listSubAgents,
  getActiveAgentId,
  setActiveAgentId,
  setAgentSystemPrompt,
  createSubAgent,
} from "@/lib/agent/subagents/store";
import { composeInstructions } from "@/lib/agent/instructions";

export const dynamic = "force-dynamic";

// The main assistant's personality is the "active agent" — one of the agents in
// data/agents. (There is no separate "profile" concept.)
export async function GET() {
  const [agents, active, composed] = await Promise.all([listSubAgents(), getActiveAgentId(), composeInstructions()]);
  const activeAgent = agents.find((a) => a.id === active);
  return NextResponse.json({
    agents: agents.map((a) => ({ id: a.id, name: a.name, description: a.description, type: a.type })),
    active,
    activeBody: activeAgent?.systemPrompt ?? "",
    composed,
  });
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    if (typeof body.active === "string") await setActiveAgentId(body.active);
    if (typeof body.body === "string") await setAgentSystemPrompt(await getActiveAgentId(), body.body);
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
