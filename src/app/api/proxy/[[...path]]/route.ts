import { NextRequest, NextResponse } from "next/server";
import { isBlockedHost } from "@/lib/net";
import { rewriteHtml, rewriteCss } from "@/lib/proxy-rewrite";
import { PROXY_PREFIX } from "@/lib/proxy-path";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BYTES = 6 * 1024 * 1024;

// Reconstruct the target from the pathname (preserving trailing slash, which
// matters for relative URL resolution) or the legacy ?url= query.
function resolveTarget(req: NextRequest): string | null {
  const url = new URL(req.url);
  if (url.pathname.length > PROXY_PREFIX.length && url.pathname.startsWith(PROXY_PREFIX)) {
    const rest = url.pathname.slice(PROXY_PREFIX.length); // e.g. "https/host/a/b/"
    const slash = rest.indexOf("/");
    if (slash > 0) {
      const scheme = rest.slice(0, slash);
      const hostAndPath = rest.slice(slash + 1);
      if (scheme === "http" || scheme === "https") return `${scheme}://${hostAndPath}${url.search}`;
    }
  }
  return url.searchParams.get("url");
}

export async function GET(req: NextRequest) {
  const raw = resolveTarget(req);
  if (!raw) return new NextResponse("Missing url", { status: 400 });

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return new NextResponse("Invalid url", { status: 400 });
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return new NextResponse("Only http/https is supported", { status: 400 });
  }
  if (isBlockedHost(target.hostname)) {
    return new NextResponse("This host is blocked by the browser proxy", { status: 403 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) BrowserOS/0.1 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      },
      redirect: "follow",
    });
  } catch (err) {
    return new NextResponse(`Failed to fetch: ${(err as Error).message}`, { status: 502 });
  }

  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";

  if (contentType.includes("text/html")) {
    let html = await upstream.text();
    if (html.length > MAX_BYTES) html = html.slice(0, MAX_BYTES);
    return new NextResponse(rewriteHtml(html, upstream.url), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  if (contentType.includes("text/css")) {
    const css = await upstream.text();
    return new NextResponse(rewriteCss(css, upstream.url), {
      headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  const buf = Buffer.from(await upstream.arrayBuffer());
  return new NextResponse(new Uint8Array(buf), {
    headers: { "Content-Type": contentType, "Cache-Control": "no-store" },
  });
}
