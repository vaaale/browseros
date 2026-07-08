import { NextResponse } from "next/server";
import "@/lib/integrations"; // side-effect: register manifests
import { disconnectBot } from "@/lib/integrations/services/telegram/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/integrations/telegram/bot/disconnect
// Deletes the bot token from SecretsStore and clears connected state.
// User config (poll interval, defaultParseMode, webhook config) is preserved
// so reconnecting doesn't wipe preferences.
export async function POST() {
  await disconnectBot();
  return NextResponse.json({ ok: true });
}
