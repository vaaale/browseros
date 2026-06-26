import { NextResponse } from "next/server";
import * as vfs from "@/os/vfs";
import { mimeForPath } from "@/lib/mime";

export const dynamic = "force-dynamic";

// Serves runtime-installed app files from the VFS (/Apps/<id>/...). Apps load in
// an iframe at /apps/<id>/ and may call BrowserOS APIs (same-origin).
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await ctx.params;
  if (!slug || slug.length === 0) return new NextResponse("Not found", { status: 404 });
  const id = slug[0];
  const rel = slug.slice(1).join("/") || "index.html";
  try {
    const contentType = mimeForPath(rel);
    // For HTML, inject a <base> so the app's relative URLs resolve under
    // /apps/<id>/ even though the iframe loads /apps/<id> (no trailing slash).
    if (contentType.startsWith("text/html")) {
      let html = await vfs.readText(`/Apps/${id}/${rel}`);
      const baseTag = `<base href="/apps/${id}/">`;
      html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${baseTag}`) : `${baseTag}${html}`;
      return new NextResponse(html, { headers: { "Content-Type": contentType, "Cache-Control": "no-store" } });
    }
    const data = await vfs.readBuffer(`/Apps/${id}/${rel}`);
    return new NextResponse(new Uint8Array(data), {
      headers: { "Content-Type": contentType, "Cache-Control": "no-store" },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
