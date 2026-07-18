import { NextRequest, NextResponse } from "next/server";
import { startAssistantRun } from "@/lib/assistant/start-run";
import { ActiveRunError, runManager, type SurfaceAgentEntry } from "@/lib/assistant/run-manager";
import type { ToolDeclaration } from "@/lib/assistant/tools";
import type { Attachment } from "@/lib/assistant/messages";
import { registerVoiceModeHook } from "@/lib/voice/voice-hook";

export const dynamic = "force-dynamic";

// Register the voice-mode system-prompt hook once at module load time.
registerVoiceModeHook();

// POST — start a run (the loop runs detached from this request).
//   { conversationId, agentId, message, editOfMessageId?, surfaceTools?, surfaceAgents? }
// 409 when the conversation already has an active run (edit-resubmit instead
// auto-cancels it) or when editOfMessageId is not the last user message.
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      conversationId?: string;
      agentId?: string;
      message?: string;
      editOfMessageId?: string;
      surfaceTools?: ToolDeclaration[];
      surfaceAgents?: SurfaceAgentEntry[];
      attachments?: Attachment[];
    };
    const conversationId = body.conversationId?.trim();
    const agentId = body.agentId?.trim();
    const message = typeof body.message === "string" ? body.message : "";
    const attachments = Array.isArray(body.attachments) ? body.attachments : undefined;
    // A message is required UNLESS attachments are present (image-only turns ok).
    if (!conversationId || !agentId || (!message.trim() && !attachments?.length)) {
      return NextResponse.json({ error: "conversationId, agentId and message (or attachments) are required" }, { status: 400 });
    }
    const run = await startAssistantRun({
      conversationId,
      agentId,
      message,
      editOfMessageId: body.editOfMessageId?.trim() || undefined,
      surfaceTools: Array.isArray(body.surfaceTools) ? body.surfaceTools : undefined,
      surfaceAgents: Array.isArray(body.surfaceAgents) ? body.surfaceAgents : undefined,
      attachments,
    });
    return NextResponse.json({ runId: run.id }, { status: 201 });
  } catch (e) {
    if (e instanceof ActiveRunError) {
      return NextResponse.json({ error: e.message, activeRunId: e.activeRunId }, { status: 409 });
    }
    const msg = (e as Error).message;
    const status = /not the last user message/.test(msg) ? 409 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

// GET ?conversationId= — the conversation's active run, if any (reconnect path).
export async function GET(req: NextRequest) {
  const conversationId = new URL(req.url).searchParams.get("conversationId")?.trim();
  if (!conversationId) {
    return NextResponse.json({ error: "conversationId is required" }, { status: 400 });
  }
  const run = runManager().activeFor(conversationId);
  return NextResponse.json(
    run ? { runId: run.id, agentId: run.agentId, startedAt: run.startedAt, status: run.status } : { runId: null },
  );
}
