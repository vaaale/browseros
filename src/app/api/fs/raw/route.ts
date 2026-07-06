import { NextRequest, NextResponse } from "next/server";
import path from "path";
import * as vfs from "@/os/vfs";

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

export async function GET(req: NextRequest) {
  const p = new URL(req.url).searchParams.get("path");
  if (!p) return NextResponse.json({ error: "Missing path" }, { status: 400 });
  try {
    const data = await vfs.readBuffer(p);
    const type = MIME[path.extname(p).toLowerCase()] ?? "application/octet-stream";
    return new NextResponse(new Uint8Array(data), {
      headers: { "Content-Type": type, "Cache-Control": "no-store" },
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 404 });
  }
}
