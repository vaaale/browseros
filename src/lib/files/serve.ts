import "server-only";
import { NextResponse } from "next/server";
import { Readable } from "stream";
import path from "path";
import * as vfs from "@/os/vfs";

// Streaming a VFS file's bytes to the browser — the shared body of BOTH shapes
// of the raw-file route (`/api/fs/raw?path=…` and `/api/fs/raw/<path>`). One
// implementation so the two URL shapes can never disagree about a file's
// Content-Type or its 404 behavior; the routes differ only in how the path
// reaches them.

// Content-Type for STREAMED bytes — a serving concern, deliberately larger and
// separate from the handler-matching map in src/os/file-handlers.ts (see the
// comment there). An extension missing here streams as
// application/octet-stream, which the browser downloads rather than renders.
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
  ".m4v": "video/mp4",
  ".avi": "video/x-msvideo",
};

/**
 * Stream one VFS file, without buffering it in memory (vfs.ts's `readStream`) —
 * the primitive a large-file consumer (e.g. a marketplace-item service mounting
 * the VFS over WebDAV) needs. Call it INSIDE `withFeatureScope` so a
 * branch-coupled mount (/Specs, /Docs) resolves against the right worktree.
 *
 * Anything unreadable — missing file, a directory, a path escaping the VFS root
 * (vfs.ts rejects it) — answers 404 with the error message rather than throwing,
 * because every caller is an HTTP route.
 */
export async function serveVfsFile(vfsPath: string): Promise<NextResponse> {
  try {
    const info = await vfs.stat(vfsPath);
    // A directory has no bytes. Answered here rather than left to readStream,
    // which fails only AFTER the headers (with the directory's size as
    // Content-Length) have gone out — the browser sees a broken connection
    // instead of a miss. Relative links inside a previewed document ("docs/")
    // make directory URLs genuinely reachable, so this is a real case.
    if (info.type === "dir") return NextResponse.json({ error: `Not a file: ${vfsPath}` }, { status: 404 });
    const nodeStream = await vfs.readStream(vfsPath);
    const webStream = Readable.toWeb(nodeStream as Readable) as ReadableStream;
    const type = MIME[path.extname(vfsPath).toLowerCase()] ?? "application/octet-stream";
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
}
