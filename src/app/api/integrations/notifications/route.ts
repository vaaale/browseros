import { NextRequest, NextResponse } from "next/server";
import "@/lib/integrations"; // side-effect: register manifests
import { listNotifications, markAllRead, unreadCount } from "@/lib/integrations/notifications/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET  /api/integrations/notifications          → { items, unread }
// GET  /api/integrations/notifications?count=1  → { unread }  (cheap poll)
// POST /api/integrations/notifications          → mark ALL read
//                                                  { markedRead: number }
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  if (url.searchParams.get("count") === "1") {
    return NextResponse.json({ unread: await unreadCount() });
  }
  const unreadOnly = url.searchParams.get("unread") === "1";
  const items = await listNotifications({ unreadOnly });
  const unread = unreadOnly ? items.length : items.filter((i) => !i.read).length;
  return NextResponse.json({ items, unread });
}

export async function POST() {
  const flipped = await markAllRead();
  return NextResponse.json({ markedRead: flipped });
}
