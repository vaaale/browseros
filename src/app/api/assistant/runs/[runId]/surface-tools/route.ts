import { NextRequest, NextResponse } from "next/server";
import { runManager } from "@/lib/assistant/run-manager";
import type { ToolDeclaration } from "@/lib/assistant/tools";

export const dynamic = "force-dynamic";

// POST { declarations: ToolDeclaration[] } — merge newly-available surface
// tool declarations into an ACTIVE run's live tool set. Without this, a
// window opened mid-run (e.g. the agent calls ui_preview_open, then wants
// ui_preview_generate) never gains that window's Tier 2 tools: surfaceTools is
// otherwise only read once, when the run starts, so the agent would have to
// wait for the conversation's NEXT run before it could call them. The client
// calls this automatically whenever the surface-tools registry changes while
// a run it's attached to is still active (see client/run-client.ts).
export async function POST(req: NextRequest, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params;
  const run = runManager().get(runId);
  if (!run) return NextResponse.json({ error: "unknown run" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { declarations?: ToolDeclaration[] };
  const declarations = Array.isArray(body.declarations) ? body.declarations : [];
  runManager().addSurfaceTools(run, declarations);
  return NextResponse.json({ ok: true });
}
