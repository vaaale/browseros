import { NextRequest, NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/os/settings";
import type { OSSettings } from "@/os/types";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ settings: await getSettings() });
}

export async function PATCH(req: NextRequest) {
  try {
    const patch = (await req.json()) as Partial<OSSettings>;
    return NextResponse.json({ settings: await updateSettings(patch) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
