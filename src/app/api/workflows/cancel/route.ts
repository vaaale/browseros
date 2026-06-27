import { NextRequest, NextResponse } from "next/server";
import { cancelWorkflow, isRunning } from "@/lib/workflows/runner";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const wasRunning = isRunning(body.id);
  const cancelled = cancelWorkflow(body.id);
  return NextResponse.json({ cancelled, wasRunning });
}
