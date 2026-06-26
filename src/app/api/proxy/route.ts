import { NextRequest, NextResponse } from "next/server";
import { isBlockedHost } from "@/lib/net";

export const dynamic = "force-dynamic";

const MAX_BYTES = 6 * 1024 * 1024;

export async function GET(req: NextRequest) {
  const raw = new URL(req.url).searchParams.get("url");
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
    const baseTag = `<base href="${upstream.url}">`;
    html = /<head[^>]*>/i.test(html)
      ? html.replace(/<head[^>]*>/i, (m) => `${m}${baseTag}`)
      : `${baseTag}${html}`;
    return new NextResponse(html, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  const buf = Buffer.from(await upstream.arrayBuffer());
  return new NextResponse(new Uint8Array(buf), {
    headers: { "Content-Type": contentType, "Cache-Control": "no-store" },
  });
}
