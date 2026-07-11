import { NextRequest, NextResponse } from "next/server";
import { runManager } from "@/lib/assistant/run-manager";

export const dynamic = "force-dynamic";

// POST — server-side stop. After this returns, no further model turn can start
// for this run, regardless of attached clients. Idempotent.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params;
  const run = runManager().get(runId);
  if (!run) return NextResponse.json({ error: "unknown run" }, { status: 404 });
  const cancelled = runManager().cancel(runId);
  return NextResponse.json({ ok: true, cancelled, status: run.status });
}
