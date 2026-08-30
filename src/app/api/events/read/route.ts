import { NextRequest, NextResponse } from "next/server";
import * as api from "@/lib/events/api";
import { ensureKernelReady, eventErrorResponse } from "@/lib/events/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/events/read?all=1 — mark all unread events read (contract §5)
export async function POST(req: NextRequest) {
  await ensureKernelReady();
  const all = new URL(req.url).searchParams.get("all") === "1";
  if (!all) {
    return NextResponse.json(
      { error: { code: "invalid-type", message: "expected ?all=1 — use POST /api/events/:id/read to mark a single event" } },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json(api.markAllRead());
  } catch (err) {
    return eventErrorResponse(err);
  }
}
