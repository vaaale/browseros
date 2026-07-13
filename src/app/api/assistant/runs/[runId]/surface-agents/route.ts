import { NextRequest, NextResponse } from "next/server";
import { runManager, type SurfaceAgentEntry } from "@/lib/assistant/run-manager";

export const dynamic = "force-dynamic";

// POST { agents: SurfaceAgentEntry[] } — merge newly-available surface agents
// into an ACTIVE run's live agent set (025-agent-delegation-v2), modeled 1:1
// on the existing `.../surface-tools/route.ts`: without this, a surface agent
// registered mid-run (e.g. right after ui_preview_open) would only become
// delegatable on the conversation's NEXT run. Additive-only — mirrors
// addSurfaceTools's "existing entries never overwritten" rule (and its
// accepted same-run-staleness limitation for a since-unregistered agent).
export async function POST(req: NextRequest, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params;
  const run = runManager().get(runId);
  if (!run) return NextResponse.json({ error: "unknown run" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { agents?: SurfaceAgentEntry[] };
  const agents = Array.isArray(body.agents) ? body.agents : [];
  runManager().addSurfaceAgents(run, agents);
  return NextResponse.json({ ok: true });
}
