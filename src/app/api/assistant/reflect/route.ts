import { NextRequest, NextResponse } from "next/server";
import { runReview } from "@/lib/agent/review";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Post-task self-improvement review: a separate, restricted pass (memory + skill
// tools only) that inspects the conversation and saves/updates memory and skills.
export async function POST(req: NextRequest) {
  try {
    const { transcript } = await req.json();
    if (!transcript) return NextResponse.json({ error: "transcript is required" }, { status: 400 });
    return NextResponse.json(await runReview(String(transcript)));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
