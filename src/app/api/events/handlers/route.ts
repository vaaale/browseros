import { NextRequest, NextResponse } from "next/server";
import * as api from "@/lib/events/api";
import { ensureKernelReady, eventErrorResponse } from "@/lib/events/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/events/handlers — grouped registry (contract §9)
export async function GET() {
  await ensureKernelReady();
  try {
    return NextResponse.json(api.listHandlersGrouped());
  } catch (err) {
    return eventErrorResponse(err);
  }
}

// POST /api/events/handlers — enable/disable a headless handler (contract §9)
export async function POST(req: NextRequest) {
  await ensureKernelReady();
  try {
    const body = (await req.json().catch(() => ({}))) as { handlerId?: string; ownerId?: string; enabled?: boolean };
    if (!body.handlerId || !body.ownerId || typeof body.enabled !== "boolean") {
      return NextResponse.json(
        { error: { code: "invalid-type", message: "handlerId, ownerId, and enabled are required" } },
        { status: 400 },
      );
    }
    const reg = await api.setEnabled(body.handlerId, body.ownerId, body.enabled);
    return NextResponse.json({ handlerId: reg.handlerId, enabled: reg.enabled });
  } catch (err) {
    return eventErrorResponse(err);
  }
}
