import { NextRequest, NextResponse } from "next/server";
import * as api from "@/lib/events/api";
import { ensureKernelReady, eventErrorResponse } from "@/lib/events/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/events/register (contract §6)
export async function POST(req: NextRequest) {
  await ensureKernelReady();
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const reg = await api.register(body as unknown as Parameters<typeof api.register>[0]);
    return NextResponse.json({ handlerId: reg.handlerId, enabled: reg.enabled });
  } catch (err) {
    return eventErrorResponse(err);
  }
}
