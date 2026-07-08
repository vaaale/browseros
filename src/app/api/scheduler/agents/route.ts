import { NextResponse } from "next/server";
import { listSubAgents } from "@/lib/agent/subagents/store";

export const dynamic = "force-dynamic";

// Slim list for the Scheduler UI's agent picker — the full sub-agents endpoint
// returns everything including large system prompts.
export async function GET() {
  const agents = await listSubAgents();
  return NextResponse.json({
    agents: agents.map((a) => ({ id: a.id, name: a.name, type: a.type, description: a.description })),
  });
}
