import { NextResponse } from "next/server";
import "@/lib/integrations"; // side-effect: register manifests
import { listIntegrations } from "@/lib/integrations/registry";
import { readState } from "@/lib/integrations/state/store";
import { getSecretsStore } from "@/lib/integrations/secrets/store";
import { ensureSchedulerStarted } from "@/lib/integrations/scheduler/daemon";
import { listAdapterServices } from "@/lib/integrations/actions/adapter-registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/integrations — list every registered integration with its state
// and a flag indicating whether client credentials have been uploaded.
// Also returns a flat `adapters` list so the settings UI can gate polling /
// webhook sub-sections on the (integrationId, serviceId) actually having a
// registered adapter with the corresponding capability.
export async function GET() {
  // Lazy-start the poll daemon on first UI load. Idempotent — subsequent
  // requests are a no-op.
  ensureSchedulerStarted();
  const manifests = listIntegrations();
  const items = await Promise.all(
    manifests.map(async (manifest) => {
      const state = await readState(manifest.id);
      const secretKeys = await getSecretsStore().listKeys(manifest.id);
      return {
        manifest,
        state,
        hasClientSecret: secretKeys.includes("oauth_client"),
      };
    }),
  );
  const adapters = listAdapterServices().map((a) => ({
    integrationId: a.integrationId,
    serviceId: a.serviceId,
    capabilities: a.capabilities,
  }));
  return NextResponse.json({ integrations: items, adapters });
}
