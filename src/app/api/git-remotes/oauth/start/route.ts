import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { getSecretsStore } from "@/lib/integrations/secrets/store";
import { putPending } from "@/lib/integrations/oauth/state";
import { challengeFromVerifier } from "@/lib/integrations/oauth/pkce";
import { getOAuthProvider, getGitLabAuthUrls } from "@/lib/integrations/oauth/providers";
import { resolvePublicOrigin } from "@/lib/integrations/oauth/origin";
import { gitLogger } from "@/lib/gitops/logging";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/git-remotes/oauth/start?remoteName=origin&provider=github&scopes=repo,read:user
// Returns { authUrl } — the caller (client-side popup) navigates to it.

interface GitRemoteClientSecrets {
  clientId: string;
  clientSecret: string;
  instanceUrl?: string;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const remoteName = url.searchParams.get("remoteName");
  const providerId = url.searchParams.get("provider");
  const scopesParam = url.searchParams.get("scopes");

  if (!remoteName) {
    return NextResponse.json({ error: "remoteName is required" }, { status: 400 });
  }
  if (!providerId) {
    return NextResponse.json({ error: "provider is required" }, { status: 400 });
  }

  const manifest = getOAuthProvider(providerId);
  if (!manifest) {
    return NextResponse.json({ error: `Unknown provider: ${providerId}` }, { status: 400 });
  }

  const store = getSecretsStore();
  const cs = await store.get<GitRemoteClientSecrets>("git_remote_oauth", `${providerId}:client`);
  if (!cs?.clientId || !cs?.clientSecret) {
    return NextResponse.json(
      { error: `No client credentials for ${manifest.name}. Configure them in Settings.` },
      { status: 400 },
    );
  }

  const scopes = scopesParam
    ? scopesParam.split(",").map((s) => s.trim()).filter(Boolean)
    : manifest.scopes;

  const verifier = randomBytes(32).toString("base64url");
  const challenge = challengeFromVerifier(verifier);
  const stateToken = putPending({
    integrationId: "git_remote_oauth",
    verifier,
    scopes,
    remoteName,
  });

  // Self-hosted GitLab authorizes against its own origin rather than
  // gitlab.com; fall back to the manifest URL when no instance is configured.
  const baseAuthUrl =
    providerId === "gitlab" ? getGitLabAuthUrls(cs.instanceUrl).authUrl : manifest.authUrl;

  // The redirect URI must be the public origin (matching what the user
  // registered with the provider), not the internal request origin.
  const redirectUri = `${resolvePublicOrigin(req)}/api/git-remotes/oauth/callback`;

  const authUrl = new URL(baseAuthUrl);
  authUrl.searchParams.set("client_id", cs.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scopes.join(" "));
  authUrl.searchParams.set("state", stateToken);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  gitLogger().info({ op: "oauth.start", remote: remoteName, provider: providerId });

  return NextResponse.json({ authUrl: authUrl.toString() });
}
