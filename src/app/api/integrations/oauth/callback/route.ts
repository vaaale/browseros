import { NextRequest } from "next/server";
import "@/lib/integrations";
import { getOAuthManager } from "@/lib/integrations/oauth/manager";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/integrations/oauth/callback?code=…&state=…
// Consumes the redirect from the provider and renders a small HTML page that
// posts back to the opener via postMessage and then invites the user to close
// the window. Does not depend on the opener still being there.

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return c;
    }
  });
}

function successPage(integrationId: string, grantedScopes: string[]): string {
  const payload = { type: "bos-oauth", ok: true, integrationId, grantedScopes };
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
<h1><span class="dot"></span>Connected — ${escapeHtml(integrationId)}</h1>
<p>You may close this window.</p>
<p>Granted scopes:</p>
<p><code>${escapeHtml(grantedScopes.join(" "))}</code></p>
</div>
<script>try{window.opener&&window.opener.postMessage(${JSON.stringify(json)},'*');}catch(e){}</script>
</body></html>`;
}

function errorPage(message: string, code?: string): string {
  const payload = { type: "bos-oauth", ok: false, error: message, code };
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
    const result = await getOAuthManager().handleCallback({ code, state, origin: url.origin });
    return new Response(successPage(result.integrationId, result.grantedScopes), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (err) {
    return new Response(errorPage((err as Error).message, (err as { code?: string }).code), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}
