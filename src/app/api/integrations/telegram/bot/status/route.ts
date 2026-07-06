import { NextResponse } from "next/server";
import "@/lib/integrations"; // side-effect: register manifests
import { readBotToken } from "@/lib/integrations/services/telegram/auth";
import { telegramFetch } from "@/lib/integrations/services/telegram/client";
import { listQueue } from "@/lib/integrations/services/telegram/queue";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/integrations/telegram/bot/status
//
// Return a small snapshot the settings UI uses for the "connected as
// @<botname>" card, including the current queue depth. Never leaks the
// token itself.
export async function GET() {
  const token = await readBotToken();
  if (!token) {
    return NextResponse.json({ connected: false });
  }
  try {
    const info = await telegramFetch<{ id: number; username?: string; first_name: string }>(
      token,
      "getMe",
    );
    const queue = await listQueue();
    return NextResponse.json({
      connected: true,
      botInfo: info,
      queueDepth: queue.length,
    });
  } catch (err) {
    return NextResponse.json({
      connected: false,
      error: (err as Error).message,
    });
  }
}
