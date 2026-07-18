import { NextRequest, NextResponse } from "next/server";
import * as vfs from "@/os/vfs";
import { enqueuePerKey } from "@/lib/agent/write-queue";
import { loadConversationMessages, saveConversationMessages } from "@/lib/assistant/conversation-store";
import { lastUserIndex } from "@/lib/assistant/messages";
import { runManager } from "@/lib/assistant/run-manager";

export const dynamic = "force-dynamic";

// GET — the sanitized transcript (what the loop itself would load).
export async function GET(_req: NextRequest, ctx: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await ctx.params;
  const messages = await loadConversationMessages(conversationId);
  return NextResponse.json({ messages });
}

// PATCH { messageId, feedback: { rating, at } } — stamp thumbs feedback on a
// message. The transcript is server-owned, so this is the ONE client-driven
// message mutation, and it goes through the same per-conversation write queue
// as the loop. The memory fast loop reads the stamp from the file.
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    messageId?: string;
    feedback?: { rating?: string; at?: number };
  };
  const messageId = body.messageId?.trim();
  const rating = body.feedback?.rating;
  if (!messageId || (rating !== "up" && rating !== "down")) {
    return NextResponse.json({ error: "messageId and feedback.rating (up|down) are required" }, { status: 400 });
  }
  const path = `/Documents/Chats/${conversationId}.json`;
  try {
    await enqueuePerKey(conversationId, async () => {
      const file = JSON.parse(await vfs.readText(path)) as { messages?: Array<{ id?: string }> };
      const msg = file.messages?.find((m) => m?.id === messageId);
      if (!msg) throw new Error(`message ${messageId} not found`);
      (msg as Record<string, unknown>).feedback = { rating, at: body.feedback?.at ?? Date.now() };
      await vfs.writeText(path, JSON.stringify(file, null, 2));
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 404 });
  }
}

// DELETE — remove the last turn: the most recent user message and everything
// after it (its assistant/tool responses), or just the trailing user message if
// the agent never responded. The transcript is server-owned, so like feedback
// this is a client-driven mutation gated on there being no active run.
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await ctx.params;

  if (runManager().activeFor(conversationId)) {
    return NextResponse.json({ error: "Cannot delete a turn while a run is active." }, { status: 409 });
  }

  const messages = await loadConversationMessages(conversationId);
  const idx = lastUserIndex(messages);
  if (idx === -1) {
    return NextResponse.json({ error: "No turn to delete." }, { status: 404 });
  }

  const next = messages.slice(0, idx);
  // agentId is only used to seed metadata when the file is missing; the file
  // already exists here, so its stored agentId is preserved.
  await saveConversationMessages(conversationId, "", next);
  return NextResponse.json({ messages: next });
}
