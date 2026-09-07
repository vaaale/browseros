import { NextRequest, NextResponse } from "next/server";
import { Readable } from "stream";
import * as vfs from "@/os/vfs";
import { serveVfsFile } from "@/lib/files/serve";
import { withFeatureScope, scopeFromRequest } from "@/lib/specs/feature-context";

export const dynamic = "force-dynamic";

// Raw VFS bytes by query string. The streaming itself (and the Content-Type map)
// lives in @/lib/files/serve, shared with the path-shaped `[...path]` sibling —
// which is what a previewed DOCUMENT is loaded from, so its relative references
// resolve. See that route's header for the split.
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
  return withFeatureScope(scopeFromRequest(req.headers, searchParams), () => serveVfsFile(p));
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
