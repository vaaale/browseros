import { NextRequest, NextResponse } from "next/server";
import * as api from "@/lib/events/api";
import { ensureKernelReady, eventErrorResponse } from "@/lib/events/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/events/preference — set/clear the default UI handler (contract §7)
export async function POST(req: NextRequest) {
  await ensureKernelReady();
  try {
    const body = (await req.json().catch(() => ({}))) as { eventType?: string; preferredHandlerId?: string | null };
    if (!body.eventType) {
      return NextResponse.json({ error: { code: "invalid-type", message: "eventType is required" } }, { status: 400 });
    }
    const pref = await api.setPreference(body.eventType, body.preferredHandlerId ?? null);
    return NextResponse.json({ eventType: body.eventType, preferredHandlerId: pref?.preferredHandlerId ?? null });
  } catch (err) {
    return eventErrorResponse(err);
  }
}
