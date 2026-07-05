import { NextRequest, NextResponse } from "next/server";
import { runReview } from "@/lib/agent/review";
import { runFastLoop } from "@/lib/agent/memory/fast-loop";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Post-task self-improvement review. Two modes (spec 021 FR-009):
//   { conversationId }  →  manual fast-loop trigger for that conversation
//                          (idle threshold waived; delegates to fast-loop)
//   { transcript }      →  legacy transcript-driven review (kept for the
//                          existing skill_reflect UX and headless callers)
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { transcript?: string; conversationId?: string };
    if (body.conversationId) {
      const summary = await runFastLoop({ onlyConversationId: body.conversationId, waiveIdle: true });
      return NextResponse.json(summary);
    }
    if (body.transcript) return NextResponse.json(await runReview(String(body.transcript)));
    return NextResponse.json({ error: "transcript or conversationId is required" }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
