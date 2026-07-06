import { NextRequest, NextResponse } from "next/server";
import "@/lib/integrations"; // side-effect: register manifests
import { clearAll, listQueue, remove } from "@/lib/integrations/services/telegram/queue";
import { flushQueueOnce } from "@/lib/integrations/services/telegram/poller";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET    /api/integrations/telegram/bot/queue          → { entries: QueuedSend[] }
// POST   /api/integrations/telegram/bot/queue          → { action: "flush" | "clear" | "remove", id? }
//
// The settings UI ("Offline queue" section) uses these to render the pending
// send list, drain them on demand, or discard them. The scheduler already
// flushes opportunistically via `TelegramBotAdapter.pollOnce` — this endpoint
// is a manual trigger for cases when the user wants to retry immediately.
export async function GET() {
  const entries = await listQueue();
  return NextResponse.json({ entries });
}

interface PostBody {
  action?: "flush" | "clear" | "remove";
  id?: string;
}

export async function POST(req: NextRequest) {
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: { code: "bad_request", message: "invalid JSON body" } }, { status: 400 });
  }
  switch (body.action) {
    case "flush": {
      const result = await flushQueueOnce();
      const entries = await listQueue();
      return NextResponse.json({ ...result, entries });
    }
    case "clear": {
      const cleared = await clearAll();
      return NextResponse.json({ cleared, entries: [] });
    }
    case "remove": {
      if (!body.id) {
        return NextResponse.json({ error: { code: "bad_request", message: "missing `id`" } }, { status: 400 });
      }
      const removed = await remove(body.id);
      const entries = await listQueue();
      return NextResponse.json({ removed, entries });
    }
    default:
      return NextResponse.json(
        { error: { code: "bad_request", message: `unknown action: ${String(body.action)}` } },
        { status: 400 },
      );
  }
}
