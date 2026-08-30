import { NextResponse } from "next/server";
import * as api from "@/lib/events/api";
import { ensureKernelReady, eventErrorResponse } from "@/lib/events/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/events/count — cheap bell poll fallback (contract §8)
export async function GET() {
  await ensureKernelReady();
  try {
    return NextResponse.json(api.count());
  } catch (err) {
    return eventErrorResponse(err);
  }
}
