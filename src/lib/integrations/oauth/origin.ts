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
