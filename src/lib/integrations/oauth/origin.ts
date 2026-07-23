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

// Read the configured public origin, tolerating BOTH ways the value can reach a
// server bundle:
//
//   • RUNTIME env — accessed through a computed key so Next.js does NOT inline it.
//     This is the container's live `process.env`, which wins in proxied/Docker
//     deployments where the origin is injected at run time (not `next build`).
//
//   • BUILD-TIME inline — the literal `process.env.NEXT_PUBLIC_APP_ORIGIN` form,
//     which Next.js statically replaces with the value present when `next build`
//     ran (in server bundles too, exactly like the client). This is the ONLY
//     value available when the origin was set at build time but is absent from
//     the container's runtime env — the case where the client shows the correct
//     origin (it reads the inlined literal) but the server, reading only the
//     computed key, saw `undefined` and fell back to the internal request origin
//     (e.g. `https://bos-alex:8090`), producing a mismatched redirect URI.
//
// We prefer the runtime value (deterministic per running container) and fall
// back to the build-time literal, so whichever mechanism supplied the origin
// wins. APP_ORIGIN is a non-public runtime alias that is never inlined.
interface ConfiguredOrigin {
  /** Chosen origin (runtime preferred, build-time fallback), trailing slash stripped. */
  origin: string | undefined;
  /** Raw runtime value (computed-key lookup, not inlined). */
  runtime: string | undefined;
  /** Raw build-time inlined literal value. */
  buildTime: string | undefined;
}

function readConfiguredOrigin(): ConfiguredOrigin {
  const env = process.env as Record<string, string | undefined>;
  // Runtime lookups (computed key — not inlined by Next.js).
  const runtime = env["NEXT_PUBLIC_APP_ORIGIN"]?.trim() || env["APP_ORIGIN"]?.trim();
  // Build-time inlined literal — baked in by `next build` when set then.
  const buildTime = process.env.NEXT_PUBLIC_APP_ORIGIN?.trim();
  const raw = runtime || buildTime;
  return {
    origin: raw ? raw.replace(/\/+$/, "") : undefined,
    runtime: runtime || undefined,
    buildTime: buildTime || undefined,
  };
}

// Structured breakdown of how the public origin was resolved — used both to
// return the origin and to log what was seen (env + proxy headers) for debugging
// redirect-URI mismatches.
export interface PublicOriginResolution {
  origin: string;
  source: "env" | "forwarded-headers" | "request-origin";
  configured: string | undefined;
  /** Raw NEXT_PUBLIC_APP_ORIGIN/APP_ORIGIN read from the container's runtime env. */
  configuredRuntime: string | undefined;
  /** Raw NEXT_PUBLIC_APP_ORIGIN inlined at `next build` time. */
  configuredBuildTime: string | undefined;
  forwardedProto: string | undefined;
  forwardedHost: string | undefined;
  host: string | undefined;
}

export function describePublicOrigin(req: NextRequest): PublicOriginResolution {
  const first = (value: string | null): string | undefined =>
    value?.split(",")[0]?.trim() || undefined;

  const { origin: configured, runtime: configuredRuntime, buildTime: configuredBuildTime } =
    readConfiguredOrigin();
  const forwardedProto = first(req.headers.get("x-forwarded-proto"));
  const forwardedHost = first(req.headers.get("x-forwarded-host"));
  const host = forwardedHost ?? first(req.headers.get("host"));

  const shared = { configured, configuredRuntime, configuredBuildTime, forwardedProto, forwardedHost, host };

  if (configured) {
    return { origin: configured, source: "env", ...shared };
  }

  if (host) {
    const isLocal = /^(localhost|127\.|\[::1\])/i.test(host);
    const scheme = forwardedProto ?? (isLocal ? "http" : "https");
    return { origin: `${scheme}://${host}`, source: "forwarded-headers", ...shared };
  }

  return { origin: new URL(req.url).origin, source: "request-origin", ...shared };
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
