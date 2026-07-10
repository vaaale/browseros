import { NextRequest, NextResponse } from "next/server";
import { runManager } from "@/lib/assistant/run-manager";

export const dynamic = "force-dynamic";

// POST { callId, result } — a client submits the outcome of a frontend tool
// dispatch. First claim wins; duplicates (a second tab racing) get
// { claimed: false } and are silently ignored by the loop.
export async function POST(req: NextRequest, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params;
  const run = runManager().get(runId);
  if (!run) return NextResponse.json({ error: "unknown run" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { callId?: string; result?: unknown };
  const callId = body.callId?.trim();
  if (!callId) return NextResponse.json({ error: "callId is required" }, { status: 400 });
  const result = typeof body.result === "string" ? body.result : JSON.stringify(body.result ?? "");
  const claimed = runManager().submitToolResult(run, callId, result);
  return NextResponse.json({ claimed });
}
