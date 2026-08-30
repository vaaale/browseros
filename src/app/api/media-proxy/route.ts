import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Re-serves EXTERNAL media (an absolute http(s) URL that is not this page's
// origin) so the `<img>`/`<video>` the html-viewer renders is same-origin — the
// only way an `http://` LAN endpoint (a ComfyUI box, an NVR) plays inside a BOS
// page served over HTTPS, which the browser would otherwise kill as mixed
// content before the element ever fires a request. `Range` is forwarded and the
// `206` relayed so seeking a large video still works. Same-origin targets
// (/api/fs/raw) and data: URIs never reach here — the handler only rewrites what
// `needsProxy()` in src/lib/apps/media.ts flags (see 'web-view-media' FR-010).
//
// Deliberately NOT the Browser app's proxy (/api/proxy): that one rewrites HTML,
// caps the body at 6 MiB, and applies the `isBlockedHost` SSRF guard — which
// blocks RFC-1918 and *.local hosts, i.e. exactly the LAN media servers this
// route exists to reach (SC-006).

// How long the upstream gets to produce RESPONSE HEADERS. Deliberately not a
// whole-request deadline (which is all AbortSignal.timeout can express): a large
// video legitimately takes minutes to stream, and aborting mid-play is the
// failure this route exists to prevent. The timer is cleared the moment `fetch`
// resolves — i.e. when the headers land, before the body is read.
const HEADERS_TIMEOUT_MS = 15_000;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  // `URLSearchParams` already percent-decodes once, and that single decode IS
  // the inverse of the client's `encodeURIComponent(target)`. Do NOT decode
  // again: a target carrying a legitimate escape (…/view?filename=clip%20(1).mp4)
  // would collapse into a malformed upstream URL.
  const src = searchParams.get("src");
  if (!src) return NextResponse.json({ error: "Missing src" }, { status: 400 });

  let target: URL;
  try {
    target = new URL(src);
  } catch {
    return NextResponse.json({ error: `Not an absolute URL: ${src}` }, { status: 400 });
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return NextResponse.json({ error: `Unsupported scheme: ${target.protocol}` }, { status: 400 });
  }

  const range = req.headers.get("range");
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), HEADERS_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      headers: range ? { Range: range } : {},
      signal: abort.signal,
      redirect: "follow",
    });
  } catch (err) {
    // DNS failure, connection refused, TLS error, or the headers timeout above.
    // A 502 (rather than a silent empty 200) is what makes the media element's
    // onError fire and the viewer's "Could not load" card appear — FR-011.
    return NextResponse.json({ error: `Could not reach ${target.href}: ${(err as Error).message}` }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }

  if (!upstream.ok) {
    await upstream.body?.cancel().catch(() => {});
    return NextResponse.json({ error: `Upstream returned HTTP ${upstream.status} for ${target.href}` }, { status: 502 });
  }

  // Relay only what the media element needs, verbatim. No CORS headers: the
  // response is same-origin to the BOS page by construction.
  const headers = new Headers({ "Cache-Control": "no-store" });
  const type = upstream.headers.get("content-type");
  if (type) headers.set("Content-Type", type);
  const length = upstream.headers.get("content-length");
  if (length) headers.set("Content-Length", length);
  const acceptRanges = upstream.headers.get("accept-ranges");
  if (acceptRanges) headers.set("Accept-Ranges", acceptRanges);
  if (upstream.status === 206) {
    const contentRange = upstream.headers.get("content-range");
    if (contentRange) headers.set("Content-Range", contentRange);
  }

  // `fetch` already hands back a Web ReadableStream, so the bytes pass straight
  // through — nothing buffers the file in memory (NFR-002), which is the whole
  // point for a multi-hundred-MB video.
  return new NextResponse(upstream.body, { status: upstream.status, headers });
}
