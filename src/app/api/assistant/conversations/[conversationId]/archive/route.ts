import { NextRequest, NextResponse } from "next/server";
import { getConversationMeta, patchConversationMeta } from "@/lib/assistant/conversation-store";

export const dynamic = "force-dynamic";

// PATCH { archived: boolean } — set or clear a conversation's archived flag
// (038-conversation-archive). Routed through conversation-store.ts's own
// per-conversation queue — not a plain VFS write — so this serializes against
// the v2 agent loop's own message saves instead of racing them (the same
// pattern, and reason, as the feature-branches PATCH route).
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await ctx.params;
  let body: { archived?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.archived !== "boolean") {
    return NextResponse.json({ ok: false, error: "archived (boolean) is required" }, { status: 400 });
  }
  if (!(await getConversationMeta(conversationId))) {
    return NextResponse.json({ ok: false, error: `Conversation "${conversationId}" not found` }, { status: 404 });
  }
  await patchConversationMeta(conversationId, { archived: body.archived });
  const meta = await getConversationMeta(conversationId);
  return NextResponse.json({ ok: true, meta });
}
