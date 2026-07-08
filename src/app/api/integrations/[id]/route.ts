import { NextRequest, NextResponse } from "next/server";
import "@/lib/integrations"; // side-effect: register manifests
import { getIntegration } from "@/lib/integrations/registry";
import { getSecretsStore } from "@/lib/integrations/secrets/store";
import { mutateState, readState } from "@/lib/integrations/state/store";
import type { IntegrationServiceState, IntegrationState } from "@/lib/integrations/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PatchBody {
  services?: Record<string, Partial<IntegrationServiceState>>;
  scopeOverrides?: Record<string, boolean>;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const manifest = getIntegration(id);
  if (!manifest) return NextResponse.json({ error: `Unknown integration: ${id}` }, { status: 404 });
  const state = await readState(id);
  const secretKeys = await getSecretsStore().listKeys(id);
  return NextResponse.json({
    manifest,
    state,
    hasClientSecret: secretKeys.includes("oauth_client"),
  });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const manifest = getIntegration(id);
  if (!manifest) return NextResponse.json({ error: `Unknown integration: ${id}` }, { status: 404 });
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const next = await mutateState(id, (prev): IntegrationState => {
    const services: IntegrationState["services"] = { ...prev.services };
    if (body.services) {
      for (const [sid, patch] of Object.entries(body.services)) {
        // Only accept keys for services declared in the manifest.
        if (!manifest.services.some((s) => s.id === sid)) continue;
        const existing = services[sid] ?? { enabled: false, config: {} };
        services[sid] = {
          ...existing,
          ...patch,
          config: patch.config ? { ...existing.config, ...patch.config } : existing.config,
        };
      }
    }
    const scopeOverrides = { ...prev.scopeOverrides };
    if (body.scopeOverrides) {
      const granted = new Set(prev.oauthMeta?.granted_scopes ?? []);
      for (const [scope, enabled] of Object.entries(body.scopeOverrides)) {
        if (enabled === false) {
          // Can only disable a scope we were actually granted.
          if (!granted.has(scope)) continue;
          scopeOverrides[scope] = false;
        } else {
          delete scopeOverrides[scope];
        }
      }
    }
    return { ...prev, services, scopeOverrides };
  });

  return NextResponse.json({ state: next });
}
