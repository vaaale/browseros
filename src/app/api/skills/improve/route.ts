import { NextRequest, NextResponse } from "next/server";
import { improveSkill } from "@/lib/agent/skills/improve";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// GEPA-lite: improve a skill from feedback (user-provided or self-reflection).
export async function POST(req: NextRequest) {
  try {
    const { skill, feedback } = await req.json();
    if (!skill || !feedback) return NextResponse.json({ error: "skill and feedback are required" }, { status: 400 });
    const improved = await improveSkill(String(skill), String(feedback));
    if (!improved) return NextResponse.json({ error: "Could not improve (skill not found or no provider)." }, { status: 400 });
    return NextResponse.json({ skill: { id: improved.id, name: improved.name, score: improved.score } });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
