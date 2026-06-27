import { NextRequest, NextResponse } from "next/server";
import { getWorkflow } from "@/lib/workflows/store";
import { validateWorkflow } from "@/lib/workflows/validate";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const wf = await getWorkflow(body.id);
  if (!wf) return NextResponse.json({ error: `No workflow "${body.id}"` }, { status: 404 });
  return NextResponse.json(await validateWorkflow(wf));
}
