import { NextResponse } from "next/server";
import { runCurator } from "@/lib/agent/skills/curator";

export const dynamic = "force-dynamic";

// Runs the skill Curator on demand (BOS has no background daemon). Archives
// stale, agent-created, unpinned skills (recoverable).
export async function POST() {
  try {
    return NextResponse.json(await runCurator());
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
