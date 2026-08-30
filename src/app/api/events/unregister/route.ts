import { NextRequest, NextResponse } from "next/server";
import * as api from "@/lib/events/api";
import { ensureKernelReady, eventErrorResponse } from "@/lib/events/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/events/unregister (contract §6)
export async function POST(req: NextRequest) {
  await ensureKernelReady();
  try {
    const body = (await req.json().catch(() => ({}))) as { handlerId?: string; ownerId?: string };
    if (!body.handlerId || !body.ownerId) {
      return NextResponse.json({ error: { code: "invalid-type", message: "handlerId and ownerId are required" } }, { status: 400 });
    }
    await api.unregister(body.handlerId, body.ownerId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return eventErrorResponse(err);
  }
}
