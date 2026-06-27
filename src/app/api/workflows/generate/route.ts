import { NextRequest, NextResponse } from "next/server";
import { generateWorkflowFromTask } from "@/lib/workflows/generate";
import { saveWorkflow } from "@/lib/workflows/store";
import { validateWorkflow } from "@/lib/workflows/validate";
import { ensureWorkflowApp } from "@/lib/workflows/install";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  let body: { task?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.task) return NextResponse.json({ error: "task is required" }, { status: 400 });
  try {
    await ensureWorkflowApp().catch(() => {});
    const wf = await generateWorkflowFromTask(String(body.task));
    const saved = await saveWorkflow(wf);
    const validation = await validateWorkflow(saved);
    return NextResponse.json({ workflow: saved, validation });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
