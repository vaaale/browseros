import { NextResponse } from "next/server";
import "@/lib/integrations";
import { GmailAdapter } from "@/lib/integrations/services/gsuite/adapters/gmail";
import { IntegrationError } from "@/lib/integrations/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/integrations/gsuite/whoami — a thin passthrough to
// GmailAdapter.getProfile() used by the Settings UI auth card to render
// "Connected as user@example.com". Gated by the same `gmail.readonly` scope
// as any other adapter call.
export async function GET() {
  try {
    const adapter = new GmailAdapter();
    const profile = await adapter.getProfile();
    return NextResponse.json(profile);
  } catch (err) {
    const code = err instanceof IntegrationError ? err.code : "internal_error";
    const status = code === "auth_failed" || code === "scope_disabled" ? 401 : 500;
    return NextResponse.json({ error: (err as Error).message, code }, { status });
  }
}
