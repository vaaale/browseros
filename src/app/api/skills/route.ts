import { NextRequest, NextResponse } from "next/server";
import { listSkills, getSkill, saveSkill, removeSkill } from "@/lib/agent/skills/store";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (id) return NextResponse.json({ skill: await getSkill(id) });
  return NextResponse.json({ skills: await listSkills() });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body.name || !body.content) return NextResponse.json({ error: "name and content are required" }, { status: 400 });
    const skill = await saveSkill({
      name: String(body.name),
      description: String(body.description ?? ""),
      content: String(body.content),
      whenToUse: body.whenToUse ? String(body.whenToUse) : undefined,
    });
    return NextResponse.json({ skill });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id query param required" }, { status: 400 });
  await removeSkill(id);
  return NextResponse.json({ skills: await listSkills() });
}
