import type { NextRequest } from "next/server";

// Resolve the public-facing origin (scheme + host[:port]) that OAuth providers
// should redirect back to. This MUST match the redirect URI registered with the
// provider exactly, and MUST be identical between the authorize request and the
// token exchange.
//
// The raw request URL is unreliable behind a reverse proxy (e.g. the bastion /
// an ingress terminating TLS at bos.schmopilot.com): `new URL(req.url).origin`
// reflects the internal origin such as `http://localhost:3000`, which the
// provider rejects with "the redirect URI included is not valid".
//
// Resolution order:
//   1. NEXT_PUBLIC_APP_ORIGIN — explicit, deterministic; the recommended way to
//      pin the public URL in proxied deployments (also used by the integrations
//      OAuth manager and webhooks).
//   2. X-Forwarded-Proto / X-Forwarded-Host (or Host) — standard proxy headers.
//   3. The request's own origin — correct for direct local development.
export function resolvePublicOrigin(req: NextRequest): string {
  const configured = process.env.NEXT_PUBLIC_APP_ORIGIN?.trim();
  if (configured) return configured.replace(/\/+$/, "");

  const first = (value: string | null): string | undefined =>
    value?.split(",")[0]?.trim() || undefined;

  const proto = first(req.headers.get("x-forwarded-proto"));
  const host = first(req.headers.get("x-forwarded-host")) ?? first(req.headers.get("host"));

  if (host) {
    const isLocal = /^(localhost|127\.|\[::1\])/i.test(host);
    const scheme = proto ?? (isLocal ? "http" : "https");
    return `${scheme}://${host}`;
  }

  return new URL(req.url).origin;
}

// Callback path git-remote OAuth flows redirect back to. Shared between the
// start route, the callback route (which must send a byte-for-byte identical
// redirect_uri), and the settings UI that shows it to the user.
export const GIT_REMOTE_OAUTH_CALLBACK_PATH = "/api/git-remotes/oauth/callback";

// Client-safe counterpart to resolvePublicOrigin. Runs in the browser (no
// request object / proxy headers available), so it resolves the public origin
// from NEXT_PUBLIC_APP_ORIGIN (inlined at build time) and falls back to the
// browser's own origin. Returns "" during SSR when neither is available.
export function resolveClientPublicOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_APP_ORIGIN?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  if (typeof window !== "undefined") return window.location.origin;
  return "";
}

// Full public redirect URI for a callback path, resolved on the client. Mirrors
// what resolvePublicOrigin(req) + callbackPath produce on the server so the URL
// shown in Settings matches what the OAuth flow actually sends to the provider.
export function getRedirectUri(callbackPath: string): string {
  return `${resolveClientPublicOrigin()}${callbackPath}`;
}
