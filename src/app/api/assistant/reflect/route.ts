import { NextRequest, NextResponse } from "next/server";
import { runReview } from "@/lib/agent/review";
import { runFastLoop } from "@/lib/agent/memory/fast-loop";
import { logger } from "@/lib/logging";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Post-task self-improvement review. Three modes (spec 021 FR-009, spec 023 §Memory Loops):
//   { conversationId }  →  manual fast-loop trigger for that conversation
//                          (idle threshold waived; delegates to fast-loop)
//   { runAll: true }    →  manual fast-loop trigger across all eligible
//                          conversations (idle threshold waived)
//   { transcript }      →  legacy transcript-driven review (kept for the
//                          existing skill_reflect UX and headless callers)
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      transcript?: string;
      conversationId?: string;
      runAll?: boolean;
    };
    if (body.conversationId) {
      logger().log({
        level: "info",
        component: "memory.fast-loop",
        conversation: body.conversationId,
        msg: "manual fast-loop triggered",
      });
      const summary = await runFastLoop({ onlyConversationId: body.conversationId, waiveIdle: true });
      return NextResponse.json(summary);
    }
    if (body.runAll) {
      logger().info("memory.fast-loop", "manual fast-loop triggered for all conversations");
      const summary = await runFastLoop({ waiveIdle: true });
      return NextResponse.json(summary);
    }
    if (body.transcript) return NextResponse.json(await runReview(String(body.transcript)));
    return NextResponse.json({ error: "transcript, conversationId, or runAll is required" }, { status: 400 });
  } catch (err) {
    logger().error("memory.fast-loop", "reflect route failed", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
