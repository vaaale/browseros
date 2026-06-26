import { NextRequest, NextResponse } from "next/server";
import { getProfile, updateInstructions, addSkill, removeSkill, composeInstructions } from "@/lib/agent/profile";

export const dynamic = "force-dynamic";

export async function GET() {
  const profile = await getProfile();
  return NextResponse.json({ profile, composed: composeInstructions(profile) });
}

export async function PATCH(req: NextRequest) {
  try {
    const { instructions } = await req.json();
    if (typeof instructions !== "string") return NextResponse.json({ error: "instructions must be a string" }, { status: 400 });
    return NextResponse.json({ profile: await updateInstructions(instructions) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { name, content } = await req.json();
    if (!name || !content) return NextResponse.json({ error: "name and content are required" }, { status: 400 });
    return NextResponse.json({ profile: await addSkill({ name: String(name), content: String(content) }) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  const name = new URL(req.url).searchParams.get("skill");
  if (!name) return NextResponse.json({ error: "skill query param required" }, { status: 400 });
  return NextResponse.json({ profile: await removeSkill(name) });
}
