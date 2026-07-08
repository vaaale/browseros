import { NextRequest, NextResponse } from "next/server";
import { getWorkflow } from "@/lib/workflows/store";
import { runWorkflowStream } from "@/lib/workflows/runner";
import { validateWorkflow } from "@/lib/workflows/validate";

export const dynamic = "force-dynamic";
// Workflows can be long-running; keep the NDJSON stream alive.
export const maxDuration = 600;

export async function POST(req: NextRequest) {
  let body: { id?: string; conversationId?: string; featureBranch?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const wf = await getWorkflow(body.id);
  if (!wf) return NextResponse.json({ error: `No workflow "${body.id}"` }, { status: 404 });
  // Optional lookup key or explicit branch for dev delegations. The runner only
  // hands the harness a validated `bos/...` branch, never an arbitrary key.
  const conversationId = typeof body.conversationId === "string" ? body.conversationId : undefined;
  const featureBranch = typeof body.featureBranch === "string" ? body.featureBranch : undefined;

  const validation = await validateWorkflow(wf);
  if (!validation.ok) {
    return NextResponse.json({ error: "Validation failed", validation }, { status: 400 });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      try {
        for await (const ev of runWorkflowStream(wf, { conversationId, featureBranch })) {
          controller.enqueue(enc.encode(JSON.stringify(ev) + "\n"));
        }
      } catch (err) {
        controller.enqueue(enc.encode(JSON.stringify({ type: "workflow.fail", workflowId: wf.id, ts: Date.now(), error: (err as Error).message }) + "\n"));
      }
      controller.close();
    },
  });

  return new NextResponse(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}
