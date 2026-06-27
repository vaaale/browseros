import { NextRequest, NextResponse } from "next/server";
import { getStatus } from "@/lib/workflows/store";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id query param required" }, { status: 400 });
  const status = await getStatus(id);
  if (!status) return NextResponse.json({ error: `No workflow "${id}"` }, { status: 404 });
  return NextResponse.json({ status });
}
