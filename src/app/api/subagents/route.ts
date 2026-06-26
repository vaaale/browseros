import { NextRequest, NextResponse } from "next/server";
import { listSubAgents, createSubAgent, removeSubAgent } from "@/lib/agent/subagents/store";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ subAgents: await listSubAgents() });
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
      systemPrompt: String(body.systemPrompt),
      tools: Array.isArray(body.tools) ? body.tools.map(String) : undefined,
    });
    return NextResponse.json({ subAgent: agent });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id query param required" }, { status: 400 });
  return NextResponse.json({ subAgents: await removeSubAgent(id) });
}
