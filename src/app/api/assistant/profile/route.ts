import { NextRequest, NextResponse } from "next/server";
import { listProfiles, getActiveProfileId, setActiveProfileId, createProfile, updateActiveProfileBody } from "@/lib/agent/profiles/store";
import { composeInstructions } from "@/lib/agent/instructions";

export const dynamic = "force-dynamic";

export async function GET() {
  const [profiles, active, composed] = await Promise.all([listProfiles(), getActiveProfileId(), composeInstructions()]);
  return NextResponse.json({
    profiles: profiles.map((p) => ({ id: p.id, name: p.name, description: p.description })),
    active,
    composed,
  });
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    if (typeof body.active === "string") await setActiveProfileId(body.active);
    if (typeof body.body === "string") await updateActiveProfileBody(body.body);
    return NextResponse.json({ active: await getActiveProfileId() });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body.name || !body.body) return NextResponse.json({ error: "name and body are required" }, { status: 400 });
    const profile = await createProfile({ name: String(body.name), description: String(body.description ?? ""), body: String(body.body) });
    return NextResponse.json({ profile });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
