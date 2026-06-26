// Path-based proxy URL scheme so a proxied page's RELATIVE URLs (including ES
// module imports the browser resolves itself) map back to the proxy correctly.
// A real URL https://host/a/b.js becomes /api/proxy/https/host/a/b.js, so the
// browser resolving "./c.js" yields /api/proxy/https/host/a/c.js. No "//" is used
// (scheme is its own segment) to avoid path normalization collapsing it.

export const PROXY_PREFIX = "/api/proxy/";

export function toProxyPath(absUrl: string): string {
  try {
    const u = new URL(absUrl);
    return `${PROXY_PREFIX}${u.protocol.replace(":", "")}/${u.host}${u.pathname}${u.search}`;
  } catch {
    return absUrl;
  }
}

/** Reconstruct the real target URL from proxy path segments + query string. */
export function fromProxySegments(segments: string[] | undefined, search: string): string | null {
  if (!segments || segments.length < 2) return null;
  const scheme = segments[0];
  if (scheme !== "http" && scheme !== "https") return null;
  return `${scheme}://${segments.slice(1).join("/")}${search || ""}`;
}
