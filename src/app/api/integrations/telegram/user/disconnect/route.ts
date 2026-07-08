import { NextResponse } from "next/server";
import "@/lib/integrations"; // side-effect: register manifests
import { disconnectUser } from "@/lib/integrations/services/telegram/auth";
import { clearIndex } from "@/lib/integrations/services/telegram/search-index";
import { clearUserCaches } from "@/lib/integrations/services/telegram/user-cache";
import { IntegrationError } from "@/lib/integrations/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/integrations/telegram/user/disconnect
//
// Wipes the MTProto session, api_id, api_hash, contacts/chat caches, and
// message search index. Bot service state is left untouched.
export async function POST() {
  try {
    await disconnectUser();
    await clearUserCaches();
    // Best-effort — index might not exist yet.
    await clearIndex().catch(() => undefined);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof IntegrationError) {
      return NextResponse.json(
        { error: { code: err.code, message: err.message } },
        { status: 500 },
      );
    }
    return NextResponse.json(
      { error: { code: "internal", message: (err as Error).message ?? "internal error" } },
      { status: 500 },
    );
  }
}
