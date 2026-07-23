import { NextRequest, NextResponse } from "next/server";
import "@/lib/integrations"; // side-effect: register manifests
import { getIntegration } from "@/lib/integrations/registry";
import { getSecretsStore } from "@/lib/integrations/secrets/store";
import { getOAuthProvider } from "@/lib/integrations/oauth/providers";
import type { NormalizedClientSecrets } from "@/lib/integrations/oauth/manager";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Field-based OAuth credential entry for providers that only hand out a client
// id + secret (GitHub OAuth Apps, GitLab applications, …) rather than a
// downloadable `client_secrets.json`. The Google-style JSON upload keeps using
// the sibling `client-secret` route.
//
// GET  /api/integrations/[id]/credentials  → { configured: boolean }
// POST /api/integrations/[id]/credentials  ← { clientId, clientSecret }
//
// Storage depends on the provider kind:
//  • OAuth providers (github, gitlab) — persisted under
//    `git_remote_oauth:<id>:client` so the git-remote OAuth flow picks them up.
//  • Registered integration manifests — persisted under `oauth_client:<id>` as
//    a NormalizedClientSecrets record (auth/token URLs come from the manifest,
//    which is all the OAuthManager actually reads).

const MAX_FIELD_LEN = 4096;

interface CredentialsBody {
  clientId?: unknown;
  clientSecret?: unknown;
}

/** Resolve which storage strategy applies, or null if the id is unknown. */
function resolveKind(id: string): "provider" | "integration" | null {
  if (getOAuthProvider(id)) return "provider";
  if (getIntegration(id)) return "integration";
  return null;
}

async function isConfigured(id: string, kind: "provider" | "integration"): Promise<boolean> {
  const store = getSecretsStore();
  if (kind === "provider") {
    const creds = await store.getGitProviderCredentials(id).catch(() => null);
    return !!(creds?.clientId && creds?.clientSecret);
  }
  const keys = await store.listKeys(id);
  return keys.includes("oauth_client");
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const kind = resolveKind(id);
  if (!kind) return NextResponse.json({ error: `Unknown integration: ${id}` }, { status: 404 });
  return NextResponse.json({ configured: await isConfigured(id, kind) });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const kind = resolveKind(id);
  if (!kind) return NextResponse.json({ error: `Unknown integration: ${id}` }, { status: 404 });

  let body: CredentialsBody;
  try {
    body = (await req.json()) as CredentialsBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
  const clientSecret = typeof body.clientSecret === "string" ? body.clientSecret.trim() : "";
  if (!clientId || !clientSecret) {
    return NextResponse.json({ error: "clientId and clientSecret are required." }, { status: 400 });
  }
  if (clientId.length > MAX_FIELD_LEN || clientSecret.length > MAX_FIELD_LEN) {
    return NextResponse.json({ error: "clientId/clientSecret too long." }, { status: 413 });
  }

  try {
    const store = getSecretsStore();
    if (kind === "provider") {
      await store.setGitProviderCredentials(id, { clientId, clientSecret });
    } else {
      const manifest = getIntegration(id)!;
      const normalized: NormalizedClientSecrets = {
        clientId,
        clientSecret,
        redirectUris: [],
        authUri: manifest.oauthConfig.authorizationUrl,
        tokenUri: manifest.oauthConfig.tokenUrl,
      };
      await store.set(id, "oauth_client", normalized);
    }
    return NextResponse.json({ ok: true, clientId });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
