import { NextResponse } from "next/server";
import "@/lib/integrations"; // side-effect: register manifests
import { readUserStatus } from "@/lib/integrations/services/telegram/auth";
import { indexStats } from "@/lib/integrations/services/telegram/search-index";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/integrations/telegram/user/status
//
// Snapshot used by the settings UI: whether creds are set, whether the user is
// signed in, plus the size of the local message index. Never leaks credentials
// or session material.
export async function GET() {
  try {
    const status = await readUserStatus();
    let index = { messageCount: 0 } as { messageCount: number; lastMessageAt?: number };
    try {
      index = await indexStats();
    } catch {
      // Index file may not exist yet — fine.
    }
    return NextResponse.json({ ...status, index });
  } catch (err) {
    return NextResponse.json(
      { credentialsSet: false, authorized: false, error: (err as Error).message },
      { status: 200 },
    );
  }
}
