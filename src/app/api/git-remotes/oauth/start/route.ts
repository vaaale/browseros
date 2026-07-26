import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { getSecretsStore } from "@/lib/integrations/secrets/store";
import { putPending } from "@/lib/integrations/oauth/state";
import { challengeFromVerifier } from "@/lib/integrations/oauth/pkce";
import { getOAuthProvider, getGitLabAuthUrls } from "@/lib/integrations/oauth/providers";
import { describePublicOrigin, GIT_REMOTE_OAUTH_CALLBACK_PATH } from "@/lib/integrations/oauth/origin";
import { gitLogger } from "@/lib/gitops/logging";
import { logger } from "@/lib/logging";

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

  // Self-hosted GitLab authorizes against its own origin rather than
  // gitlab.com; fall back to the manifest URL when no instance is configured.
  const baseAuthUrl =
    providerId === "gitlab" ? getGitLabAuthUrls(cs.instanceUrl).authUrl : manifest.authUrl;

  // The redirect URI must be the public origin (matching what the user
  // registered with the provider), not the internal request origin.
  //
  // Resolution: configured NEXT_PUBLIC_APP_ORIGIN/APP_ORIGIN wins (deterministic,
  // what the admin pinned). Otherwise use the browser-supplied origin — the
  // actual URL the user accessed BOS from, forwarded by the client as a query
  // param — which is correct even behind a reverse proxy that rewrites Host.
  // Only when neither is available do we fall back to the header/request guess.
  const resolved = describePublicOrigin(req);
  const browserOrigin = url.searchParams.get("browserOrigin")?.trim().replace(/\/+$/, "") || undefined;
  const publicOrigin = resolved.configuredResolved ? resolved.origin : browserOrigin || resolved.origin;
  const redirectUri = `${publicOrigin}${GIT_REMOTE_OAUTH_CALLBACK_PATH}`;

  // Persist the exact origin so the callback rebuilds a byte-for-byte identical
  // redirect_uri for the token exchange (it can't see browserOrigin).
  const stateToken = await putPending({
    // Carry the provider id so the callback can recover which provider's client
    // credentials to load (it parses this back out via the `git_remote_oauth:`
    // prefix). Without the suffix the callback resolves providerId to the bare
    // "git_remote_oauth" and the credential lookup misses.
    integrationId: `git_remote_oauth:${providerId}`,
    verifier,
    scopes,
    remoteName,
    publicOrigin,
  });

  // Log the resolved origin + inputs so redirect-URI mismatches ("the redirect
  // URI included is not valid") can be diagnosed without guessing.
  logger().info("git-remotes.oauth", "resolved OAuth redirect URI", {
    provider: providerId,
    remote: remoteName,
    redirectUri,
    publicOrigin,
    browserOrigin: browserOrigin ?? null,
    originSource: resolved.configuredResolved ? "env" : browserOrigin ? "browser-origin" : resolved.source,
    configuredResolved: resolved.configuredResolved,
    configuredOrigin: resolved.configured ?? null,
    configuredRuntime: resolved.configuredRuntime ?? null,
    configuredBuildTime: resolved.configuredBuildTime ?? null,
    forwardedProto: resolved.forwardedProto ?? null,
    forwardedHost: resolved.forwardedHost ?? null,
    host: resolved.host ?? null,
  });

  // When the origin is still a guess — no NEXT_PUBLIC_APP_ORIGIN (build or run
  // time) AND no browser-supplied origin — emit a clear, actionable warning: the
  // URI likely reflects an internal backend host and the provider will reject it.
  // A browserOrigin resolves this, so suppress the warning in that case.
  if (resolved.warning && !browserOrigin) {
    logger().warn("git-remotes.oauth", resolved.warning, {
      provider: providerId,
      remote: remoteName,
      redirectUri,
      originSource: resolved.source,
      forwardedHost: resolved.forwardedHost ?? null,
      host: resolved.host ?? null,
    });
  }

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
