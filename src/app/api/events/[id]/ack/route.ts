import { NextRequest, NextResponse } from "next/server";
import * as api from "@/lib/events/api";
import { ensureKernelReady, eventErrorResponse } from "@/lib/events/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/events/:id/ack (contract §4). Loopback-only in practice (worker
// services), but not enforced here: ownership is validated by comparing the
// caller-declared `callerId` against the handler's registered owner
// (FR-022) — a same-container integrity check, not a network boundary
// (design.md §3.5 "Ack ownership").
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await ensureKernelReady();
  const { id } = await params;
  try {
    const body = (await req.json().catch(() => ({}))) as {
      handlerId?: string;
      result?: unknown;
      callerId?: string;
      callId?: string;
    };
    if (!body.handlerId || !body.callerId) {
      return NextResponse.json(
        { error: { code: "ack-forbidden", message: "handlerId and callerId are required" } },
        { status: 403 },
      );
    }
    const result = api.ack(id, { handlerId: body.handlerId, result: body.result, callerId: body.callerId, callId: body.callId });
    return NextResponse.json(result);
  } catch (err) {
    return eventErrorResponse(err);
  }
}
