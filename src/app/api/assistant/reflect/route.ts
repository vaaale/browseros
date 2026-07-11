import { NextRequest, NextResponse } from "next/server";
import { runFastLoop } from "@/lib/agent/memory/fast-loop";
import { logger } from "@/lib/logging";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Manual fast-loop (episodic review) trigger. Two modes:
//   { conversationId }  →  review that conversation now (idle threshold waived)
//   { runAll: true }    →  review all eligible conversations now
// (The legacy transcript-driven review was retired; approach-criticism learning
// now goes through the `self_improve` action → /api/assistant/self-improve.)
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
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
    return NextResponse.json({ error: "conversationId or runAll is required" }, { status: 400 });
  } catch (err) {
    logger().error("memory.fast-loop", "reflect route failed", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
