import { NextRequest, NextResponse } from "next/server";
import * as api from "@/lib/events/api";
import { ensureKernelReady, eventErrorResponse } from "@/lib/events/http";
import type { QueryFilter } from "@/lib/events/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/events — emit (contract §1)
export async function POST(req: NextRequest) {
  await ensureKernelReady();
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const result = await api.emit(body as unknown as Parameters<typeof api.emit>[0]);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return eventErrorResponse(err);
  }
}

// GET /api/events?type&status&read&from&to&cursor&limit — query (contract §2)
export async function GET(req: NextRequest) {
  await ensureKernelReady();
  const url = new URL(req.url);
  const sp = url.searchParams;
  const filter: QueryFilter = {
    type: sp.get("type") ?? undefined,
    status: (sp.get("status") as QueryFilter["status"]) ?? undefined,
    read: (sp.get("read") as QueryFilter["read"]) ?? undefined,
    from: sp.get("from") ? Number(sp.get("from")) : undefined,
    to: sp.get("to") ? Number(sp.get("to")) : undefined,
    cursor: sp.get("cursor") ?? undefined,
    limit: sp.get("limit") ? Number(sp.get("limit")) : undefined,
  };
  try {
    return NextResponse.json(api.query(filter));
  } catch (err) {
    return eventErrorResponse(err);
  }
}
