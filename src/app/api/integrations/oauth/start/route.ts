import { NextRequest, NextResponse } from "next/server";
import "@/lib/integrations";
import { getOAuthManager } from "@/lib/integrations/oauth/manager";
import { IntegrationError } from "@/lib/integrations/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/integrations/oauth/start?integrationId=…&scopes=a,b,c
// Returns { authUrl } — the caller (client-side popup) navigates to it.
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const integrationId = url.searchParams.get("integrationId");
  if (!integrationId) return NextResponse.json({ error: "integrationId required" }, { status: 400 });
  const scopesParam = url.searchParams.get("scopes");
  const scopes = scopesParam ? scopesParam.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  try {
    const result = await getOAuthManager().startFlow({
      integrationId,
      scopes,
      origin: url.origin,
    });
    return NextResponse.json(result);
  } catch (err) {
    const status = err instanceof IntegrationError && err.code === "config_invalid" ? 400 : 500;
    return NextResponse.json({ error: (err as Error).message, code: (err as IntegrationError).code }, { status });
  }
}
