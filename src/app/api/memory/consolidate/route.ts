import { NextResponse } from "next/server";
import { runSlowLoop } from "@/lib/agent/memory/consolidate";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Manual slow-loop trigger (spec 021 §Implementation Guidance). Runs the same
// code path the scheduler invokes. `force: true` overrides the enabled flag so
// on-demand debugging works even when the loop is paused.
export async function POST(req: Request): Promise<NextResponse> {
  try {
    const body = (await req.json().catch(() => ({}))) as { force?: boolean; agent?: string };
    const summary = await runSlowLoop({ force: !!body.force, onlyAgentId: body.agent?.trim() || undefined });
    return NextResponse.json(summary);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
