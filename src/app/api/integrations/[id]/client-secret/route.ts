import { NextRequest, NextResponse } from "next/server";
import "@/lib/integrations";
import { getIntegration } from "@/lib/integrations/registry";
import { getSecretsStore } from "@/lib/integrations/secrets/store";
import { normalizeClientSecrets } from "@/lib/integrations/services/gsuite/client-secrets";
import { IntegrationError } from "@/lib/integrations/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BYTES = 32 * 1024;

// POST /api/integrations/[id]/client-secret
// Body: the raw contents of the vendor's `client_secrets.json` (JSON).
// Server-side validation happens in the integration-specific normaliser
// (Phase 1: gsuite only).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const manifest = getIntegration(id);
  if (!manifest) return NextResponse.json({ error: `Unknown integration: ${id}` }, { status: 404 });

  // Size guard — the Content-Length header is advisory; the real check is the
  // parsed body's serialised length, but rejecting oversized requests fast is
  // valuable when it's honest.
  const declared = req.headers.get("content-length");
  if (declared && Number(declared) > MAX_BYTES) {
    return NextResponse.json({ error: "client_secrets payload too large" }, { status: 413 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // Second-line size guard against a stringified body that grew unexpectedly.
  if (JSON.stringify(raw).length > MAX_BYTES) {
    return NextResponse.json({ error: "client_secrets payload too large" }, { status: 413 });
  }

  try {
    let normalized;
    switch (id) {
      case "gsuite":
        normalized = normalizeClientSecrets(raw);
        break;
      default:
        return NextResponse.json({ error: `No client-secret normaliser for integration ${id}` }, { status: 400 });
    }
    await getSecretsStore().set(id, "oauth_client", normalized);
    return NextResponse.json({ ok: true, clientId: normalized.clientId });
  } catch (err) {
    const status = err instanceof IntegrationError && err.code === "config_invalid" ? 400 : 500;
    return NextResponse.json({ error: (err as Error).message, code: (err as IntegrationError).code }, { status });
  }
}
