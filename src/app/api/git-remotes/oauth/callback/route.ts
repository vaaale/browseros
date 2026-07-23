import { NextRequest } from "next/server";
import { takePending } from "@/lib/integrations/oauth/state";
import { getSecretsStore } from "@/lib/integrations/secrets/store";
import { readRemoteConfigs, updateRemoteConfig } from "@/lib/gitops/remote-config";
import { getOAuthProvider, getGitLabAuthUrls } from "@/lib/integrations/oauth/providers";
import { gitLogger } from "@/lib/gitops/logging";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/git-remotes/oauth/callback?code=…&state=…
// Handles the OAuth callback for git remote authentication (PKCE flow).
// Exchanges the auth code for tokens, stores them in SecretsStore, and
// updates remote-config.json with token expiry metadata.

interface GitRemoteClientSecrets {
  clientId: string;
  clientSecret: string;
  instanceUrl?: string;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return c;
    }
  });
}

function successPage(remoteName: string, providerName: string, grantedScopes: string[]): string {
  const payload = { type: "bos-git-oauth", ok: true, remoteName, providerName, grantedScopes };
  const json = JSON.stringify(payload);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Connected</title>
<style>body{background:#0f1117;color:#fff;font:14px -apple-system,BlinkMacSystemFont,sans-serif;padding:32px}
.card{max-width:420px;margin:0 auto;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:24px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#4ade80;margin-right:8px;vertical-align:middle}
h1{font-size:16px;margin:0 0 8px}
p{color:rgba(255,255,255,0.7);margin:6px 0}
code{background:rgba(255,255,255,0.06);padding:2px 6px;border-radius:4px;font-size:11px}
</style></head><body>
<div class="card">
<h1><span class="dot"></span>Connected — ${escapeHtml(providerName)}</h1>
<p>Remote <code>${escapeHtml(remoteName)}</code> is now authenticated via OAuth.</p>
<p>You may close this window.</p>
<p>Granted scopes:</p>
<p><code>${escapeHtml(grantedScopes.join(" "))}</code></p>
</div>
<script>try{window.opener&&window.opener.postMessage(${JSON.stringify(json)},'*');}catch(e){}</script>
</body></html>`;
}

function errorPage(message: string, code?: string): string {
  const payload = { type: "bos-git-oauth", ok: false, error: message, code };
  const json = JSON.stringify(payload);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Connection failed</title>
<style>body{background:#0f1117;color:#fff;font:14px -apple-system,BlinkMacSystemFont,sans-serif;padding:32px}
.card{max-width:520px;margin:0 auto;background:rgba(255,80,80,0.08);border:1px solid rgba(255,80,80,0.35);border-radius:8px;padding:24px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#f87171;margin-right:8px;vertical-align:middle}
h1{font-size:16px;margin:0 0 8px}
p{color:rgba(255,255,255,0.85);margin:6px 0}
pre{background:rgba(0,0,0,0.4);padding:12px;border-radius:6px;font-size:11px;white-space:pre-wrap;word-break:break-word}
</style></head><body>
<div class="card">
<h1><span class="dot"></span>Connection failed</h1>
<p>${escapeHtml(message)}</p>
<pre>${escapeHtml(json)}</pre>
</div>
<script>try{window.opener&&window.opener.postMessage(${JSON.stringify(json)},'*');}catch(e){}</script>
</body></html>`;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const providerError = url.searchParams.get("error");

  if (providerError) {
    gitLogger().error({ op: "oauth.callback", error: { code: "PROVIDER_ERROR", message: `Provider error: ${providerError}` } });
    return new Response(errorPage(`Provider returned error: ${providerError}`, providerError), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (!code || !state) {
    return new Response(errorPage("Callback missing code or state parameter."), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  try {
    const flow = takePending(state);
    if (!flow) {
      gitLogger().error({ op: "oauth.callback", error: { code: "OAUTH_STATE_EXPIRED", message: "OAuth state expired or unknown" } });
      return new Response(errorPage("OAuth state expired or unknown. Please try connecting again."), {
        status: 400,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    const remoteName = flow.remoteName;
    if (!remoteName) {
      gitLogger().error({ op: "oauth.callback", error: { code: "NO_REMOTE_NAME", message: "No remoteName in OAuth flow" } });
      return new Response(errorPage("Invalid OAuth flow: no remote name."), {
        status: 400,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    const provider = getOAuthProvider(flow.integrationId.replace("git_remote_oauth:", ""));
    const providerName = provider?.name ?? flow.integrationId;

    const store = getSecretsStore();
    const providerId = flow.integrationId.replace("git_remote_oauth:", "");
    const cs = await store.get<GitRemoteClientSecrets>("git_remote_oauth", `${providerId}:client`);
    if (!cs?.clientId || !cs?.clientSecret) {
      throw new Error(`No client credentials for ${providerId}`);
    }

    const redirectUri = `${url.origin}/api/git-remotes/oauth/callback`;
    // Self-hosted GitLab exchanges tokens against its own origin; fall back to
    // the manifest URL when no instance URL was configured.
    const tokenUrl =
      providerId === "gitlab" ? getGitLabAuthUrls(cs.instanceUrl).tokenUrl : provider?.tokenUrl;
    if (!tokenUrl) {
      throw new Error(`No token URL for provider: ${providerId}`);
    }

    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: cs.clientId,
        client_secret: cs.clientSecret,
        code_verifier: flow.verifier,
      }).toString(),
    });

    const body = await res.json() as Record<string, unknown>;
    if (!res.ok) {
      const desc = (body as { error_description?: string; error?: string })?.error_description
        ?? (body as { error?: string })?.error
        ?? `HTTP ${res.status}`;
      throw new Error(`Token exchange failed: ${desc}`);
    }

    const accessToken = body.access_token as string | undefined;
    const expiresIn = body.expires_in as number | undefined;
    if (!accessToken || typeof expiresIn !== "number") {
      throw new Error("Provider did not return access_token/expires_in");
    }

    const grantedScopes = ((body.scope as string) ?? flow.scopes.join(" ")).split(/\s+/).filter(Boolean);

    await store.set("git_remote", `${remoteName}:oauth`, {
      access_token: accessToken,
      expires_at: Date.now() + expiresIn * 1000,
    });

    const expiresAt = Date.now() + expiresIn * 1000;
    const configs = readRemoteConfigs();
    const remoteConfig = configs.find((c) => c.name === remoteName);
    if (remoteConfig) {
      updateRemoteConfig(remoteName, { oauthTokenExpiresAt: expiresAt });
    }

    gitLogger().info({ op: "oauth.callback", remote: remoteName, provider: providerName, success: true });

    return new Response(successPage(remoteName, providerName, grantedScopes), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (err) {
    const message = (err as Error).message;
    gitLogger().error({ op: "oauth.callback", error: { code: "OAUTH_CALLBACK_FAILED", message } });
    return new Response(errorPage(message), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}
