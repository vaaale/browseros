import { NextRequest, NextResponse } from "next/server";
import { getSecretsStore } from "@/lib/integrations/secrets/store";
import { getProviderOAuthToken, deleteProviderOAuthToken } from "@/lib/gitops/git-credential-helper";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ProviderStatus {
  id: string;
  name: string;
  connected: boolean;
  connectedAs?: string;
  hasClientCredentials: boolean;
}

async function getProviderStatus(providerId: string, providerName: string): Promise<ProviderStatus> {
  const store = getSecretsStore();

  const hasClientCredentials = !!(await store.get("git_remote_oauth", `${providerId}:client`).catch(() => null));

  // OAuth is provider-wide, so connection state is a single provider-scoped
  // token lookup rather than a per-remote scan.
  const token = await getProviderOAuthToken(providerId).catch(() => null);
  const connected = !!token?.access_token;
  const connectedAs: string | undefined = undefined;

  return { id: providerId, name: providerName, connected, connectedAs, hasClientCredentials };
}

export async function GET() {
  try {
    const providers = await Promise.all([
      getProviderStatus("github", "GitHub"),
      getProviderStatus("gitlab", "GitLab"),
    ]);
    return NextResponse.json({ providers });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action, providerId } = body as {
      action?: string;
      providerId?: string;
      clientId?: string;
      clientSecret?: string;
    };

    if (action === "set-credentials" && providerId) {
      if (providerId !== "github" && providerId !== "gitlab") {
        return NextResponse.json({ error: `Unsupported provider '${providerId}'.` }, { status: 400 });
      }
      const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
      const clientSecret = typeof body.clientSecret === "string" ? body.clientSecret.trim() : "";
      if (!clientId || !clientSecret) {
        return NextResponse.json({ error: "clientId and clientSecret are required." }, { status: 400 });
      }
      const store = getSecretsStore();
      await store.set("git_remote_oauth", `${providerId}:client`, { clientId, clientSecret });
      return NextResponse.json({ ok: true });
    }

    if (action === "disconnect" && providerId) {
      const store = getSecretsStore();

      // Drop the provider-wide OAuth token and the stored client credentials.
      await deleteProviderOAuthToken(providerId).catch(() => {});
      await store.delete("git_remote_oauth", `${providerId}:client`).catch(() => {});

      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
