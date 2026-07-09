import { NextRequest, NextResponse } from "next/server";
import { startSelfImprove, getSelfImproveStatus } from "@/lib/agent/self-improve";
import { DEFAULT_AGENT_ID } from "@/lib/agent/agent-ids";

export const dynamic = "force-dynamic";

// POST { agentId, conversationId, reflection } — kick off an async self-improvement
// pass (analyzes the compacted conversation + the agent's reflection, then improves
// a skill or records a memory item). Returns immediately; the Assistant app polls
// GET for status so the user is never blocked.
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      agentId?: string;
      conversationId?: string;
      reflection?: string;
    };
    const conversationId = (body.conversationId ?? "").trim();
    const reflection = (body.reflection ?? "").trim();
    if (!conversationId) return NextResponse.json({ error: "conversationId is required" }, { status: 400 });
    if (!reflection) return NextResponse.json({ error: "reflection is required" }, { status: 400 });
    startSelfImprove({
      agentId: body.agentId?.trim() || DEFAULT_AGENT_ID,
      conversationId,
      trigger: { kind: "reflection", reflection },
    });
    return NextResponse.json({ started: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

// GET ?conversationId=... — current self-improvement status for the indicator.
export async function GET(req: NextRequest) {
  const conversationId = new URL(req.url).searchParams.get("conversationId")?.trim() ?? "";
  if (!conversationId) return NextResponse.json({ status: null });
  return NextResponse.json({ status: getSelfImproveStatus(conversationId) });
}
