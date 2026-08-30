import { NextRequest, NextResponse } from "next/server";
import * as api from "@/lib/events/api";
import { ensureKernelReady, eventErrorResponse } from "@/lib/events/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/events/:id/read — mark one event read (contract §5)
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await ensureKernelReady();
  const { id } = await params;
  try {
    return NextResponse.json(api.markRead(id));
  } catch (err) {
    return eventErrorResponse(err);
  }
}
