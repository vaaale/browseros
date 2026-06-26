import { NextRequest, NextResponse } from "next/server";
import { reflectAndLearn } from "@/lib/agent/skills/improve";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Post-task self-reflection: extract durable memories and, if warranted, save a
// new reusable skill from the conversation.
export async function POST(req: NextRequest) {
  try {
    const { transcript } = await req.json();
    if (!transcript) return NextResponse.json({ error: "transcript is required" }, { status: 400 });
    const { memories, skill } = await reflectAndLearn(String(transcript));
    return NextResponse.json({
      memories: memories.map((m) => ({ type: m.type, content: m.content })),
      skill: skill ? { id: skill.id, name: skill.name } : null,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
