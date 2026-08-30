import { NextRequest, NextResponse } from "next/server";
import * as api from "@/lib/events/api";
import { ensureKernelReady, eventErrorResponse } from "@/lib/events/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/events/:id — full event (body + state + history) (contract §3)
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await ensureKernelReady();
  const { id } = await params;
  try {
    return NextResponse.json(await api.getEvent(id));
  } catch (err) {
    return eventErrorResponse(err);
  }
}
