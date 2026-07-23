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
//   1. NEXT_PUBLIC_APP_ORIGIN (or APP_ORIGIN) — explicit, deterministic; the
//      recommended way to pin the public URL in proxied deployments (also used
//      by the integrations OAuth manager and webhooks).
//   2. X-Forwarded-Proto / X-Forwarded-Host (or Host) — standard proxy headers.
//   3. The request's own origin — correct for direct local development.

// Read the configured public origin from the RUNTIME environment.
//
// Critical: Next.js statically replaces every literal `process.env.NEXT_PUBLIC_*`
// reference with its build-time value (in server bundles too). In proxied/Docker
// deployments the origin is only present in the container's env at runtime — not
// when `next build` ran — so the inlined server-side form is baked in as
// `undefined`, and the flow silently falls back to the internal request origin
// (e.g. `https://bos-alex:8090`). Accessing `process.env` through a computed key
// defers the lookup to runtime so the container's value actually wins. APP_ORIGIN
// is a non-public alias that is never inlined, for good measure.
function readConfiguredOrigin(): string | undefined {
  const env = process.env as Record<string, string | undefined>;
  const raw = env["NEXT_PUBLIC_APP_ORIGIN"]?.trim() || env["APP_ORIGIN"]?.trim();
  return raw ? raw.replace(/\/+$/, "") : undefined;
}

// Structured breakdown of how the public origin was resolved — used both to
// return the origin and to log what was seen (env + proxy headers) for debugging
// redirect-URI mismatches.
export interface PublicOriginResolution {
  origin: string;
  source: "env" | "forwarded-headers" | "request-origin";
  configured: string | undefined;
  forwardedProto: string | undefined;
  forwardedHost: string | undefined;
  host: string | undefined;
}

export function describePublicOrigin(req: NextRequest): PublicOriginResolution {
  const first = (value: string | null): string | undefined =>
    value?.split(",")[0]?.trim() || undefined;

  const configured = readConfiguredOrigin();
  const forwardedProto = first(req.headers.get("x-forwarded-proto"));
  const forwardedHost = first(req.headers.get("x-forwarded-host"));
  const host = forwardedHost ?? first(req.headers.get("host"));

  if (configured) {
    return { origin: configured, source: "env", configured, forwardedProto, forwardedHost, host };
  }

  if (host) {
    const isLocal = /^(localhost|127\.|\[::1\])/i.test(host);
    const scheme = forwardedProto ?? (isLocal ? "http" : "https");
    return {
      origin: `${scheme}://${host}`,
      source: "forwarded-headers",
      configured,
      forwardedProto,
      forwardedHost,
      host,
    };
  }

  return {
    origin: new URL(req.url).origin,
    source: "request-origin",
    configured,
    forwardedProto,
    forwardedHost,
    host,
  };
}

export function resolvePublicOrigin(req: NextRequest): string {
  return describePublicOrigin(req).origin;
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
