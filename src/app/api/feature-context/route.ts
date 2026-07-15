import { NextRequest, NextResponse } from "next/server";
import {
  getActive,
  setActive,
  clear,
  recordTouchedSpec,
  recordTouchedSource,
} from "@/lib/specs/feature-context";

// Feature Context API (027-vfs-specfs). The client issues intent actions only
// (set / clear / append touched path) and holds a read-only mirror; the server
// module is the single writer. No whole-file replace from the client.
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ active: await getActive() });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { id?: string; description?: string };
    if (!body?.id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }
    const active = await setActive(body.id, { description: body.description });
    return NextResponse.json({ active });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function DELETE() {
  await clear();
  return NextResponse.json({ active: null });
}

export async function PATCH(req: NextRequest) {
  try {
    const body = (await req.json()) as { touchedSpec?: string; touchedSource?: string };
    if (body.touchedSpec) await recordTouchedSpec(body.touchedSpec);
    if (body.touchedSource) await recordTouchedSource(body.touchedSource);
    return NextResponse.json({ active: await getActive() });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
