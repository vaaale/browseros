import { NextRequest, NextResponse } from "next/server";
import "@/lib/integrations";
import { getIntegration } from "@/lib/integrations/registry";
import { getSecretsStore } from "@/lib/integrations/secrets/store";
import { mutateState } from "@/lib/integrations/state/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/integrations/[id]/disconnect
// Clears the stored tokens and resets `connected` / `oauthMeta`. Preserves
// per-service config so re-connecting doesn't wipe user settings.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const manifest = getIntegration(id);
  if (!manifest) return NextResponse.json({ error: `Unknown integration: ${id}` }, { status: 404 });

  await getSecretsStore().delete(id, "tokens");
  const next = await mutateState(id, (prev) => ({
    ...prev,
    connected: false,
    oauthMeta: undefined,
    scopeOverrides: {},
    lastError: undefined,
  }));
  return NextResponse.json({ ok: true, state: next });
}
