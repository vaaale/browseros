import { NextRequest, NextResponse } from "next/server";
import { Readable } from "stream";
import path from "path";
import * as vfs from "@/os/vfs";
import { withFeatureScope, scopeFromRequest } from "@/lib/specs/feature-context";

export const dynamic = "force-dynamic";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".ogv": "video/ogg",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".m4a": "audio/mp4",
  ".mov": "video/quicktime",
};

// Streams raw file bytes without buffering the whole file in memory (vfs.ts's
// readStream/writeStream) — the primitive a large-file consumer (e.g. a
// marketplace-item service mounting the VFS over WebDAV) needs, reached over a
// plain loopback HTTP call rather than importing @/os/vfs directly (a worker-
// thread service runs unbundled, outside the @/ module graph).
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const p = searchParams.get("path");
  if (!p) return NextResponse.json({ error: "Missing path" }, { status: 400 });
  // A branch-coupled mount (/Specs, /Docs) resolves the active feature branch
  // from this scope (027-vfs-specfs) — without it, a path that only exists on
  // an active feature branch's worktree silently 404s here even though it's
  // genuinely reachable through the ordinary file_* tools (which DO carry
  // scope, via a header /api/fs/route.ts reads). This route is loaded via
  // plain browser navigation (an <iframe src>, e.g. web_view's preview) which
  // cannot set custom headers, so scope travels as a query param instead —
  // see scopeFromRequest.
  return withFeatureScope(scopeFromRequest(req.headers, searchParams), async () => {
    try {
      const info = await vfs.stat(p);
      const nodeStream = await vfs.readStream(p);
      const webStream = Readable.toWeb(nodeStream as Readable) as ReadableStream;
      const type = MIME[path.extname(p).toLowerCase()] ?? "application/octet-stream";
      return new NextResponse(webStream, {
        headers: {
          "Content-Type": type,
          "Content-Length": String(info.size),
          "Cache-Control": "no-store",
        },
      });
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 404 });
    }
  });
}

// Streaming write counterpart to GET — the request body streams straight into
// the target file (write-temp-then-rename, same as every other VFS write) with
// no whole-file buffering on either side.
export async function PUT(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const p = searchParams.get("path");
  if (!p) return NextResponse.json({ error: "Missing path" }, { status: 400 });
  if (!req.body) return NextResponse.json({ error: "Missing request body" }, { status: 400 });
  return withFeatureScope(scopeFromRequest(req.headers, searchParams), async () => {
    try {
      const { stream, done } = await vfs.writeStream(p);
      const incoming = Readable.fromWeb(req.body as import("stream/web").ReadableStream);
      incoming.pipe(stream as NodeJS.WritableStream);
      await done;
      return NextResponse.json({ ok: true });
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 400 });
    }
  });
}
