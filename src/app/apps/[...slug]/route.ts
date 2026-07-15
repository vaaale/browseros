import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { appsDir } from "@/os/apps-dir";
import { dataDir } from "@/os/data-dir";
import { mimeForPath } from "@/lib/mime";

export const dynamic = "force-dynamic";

/** The app's persisted KV snapshot, inlined so the SDK's localStorage shim can
 *  hydrate SYNCHRONOUSLY (before the app's first script runs) — avoiding a cold
 *  `null` on a startup read (028). */
async function readAppStorage(id: string): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(path.join(dataDir(), "app-storage", `${id}.json`), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** JSON safe to inline inside a <script> (prevent `</script>` / `<!--` breakout). */
function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

// Serves installed app files from the apps repo (GitFS) at <appsDir>/<id>/...
// Apps load in an iframe at /apps/<id>/ and may call BrowserOS APIs (same-origin).
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await ctx.params;
  if (!slug || slug.length === 0) return new NextResponse("Not found", { status: 404 });
  const id = slug[0];
  const rel = slug.slice(1).join("/") || "index.html";

  // Built projects are served from <id>/dist (bundled output); plain static apps
  // from <id> directly. We never serve the project source for a built app.
  const appBase = path.resolve(appsDir(), id);
  const distRoot = path.join(appBase, "dist");
  const isBuilt = await fs
    .access(path.join(distRoot, "index.html"))
    .then(() => true)
    .catch(() => false);
  const root = isBuilt ? distRoot : appBase;

  // Path-escape jail: resolve under the chosen root and reject anything that
  // would climb out (e.g. ".." segments). We read the filesystem directly here,
  // so this guard is load-bearing for security.
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(root + path.sep)) {
    return new NextResponse("Not found", { status: 404 });
  }

  try {
    const contentType = mimeForPath(rel);
    // For HTML, inject a <base> so the app's relative URLs resolve under
    // /apps/<id>/ even though the iframe loads /apps/<id> (no trailing slash).
    if (contentType.startsWith("text/html")) {
      let html = await fs.readFile(target, "utf8");
      // Inject, in order: <base> (relative URLs), the storage snapshot for the
      // shim's synchronous hydrate, then the BOS SDK (installs window.__bos + the
      // localStorage/sessionStorage shim). Absolute SDK src resolves to the BOS
      // origin while apps are same-origin; 2d (cross-origin) will pin it.
      const snapshot = await readAppStorage(id);
      const head =
        `<base href="/apps/${id}/">` +
        `<script>window.__bos_storage_snapshot=${inlineJson(snapshot)};</script>` +
        `<script src="/api/iframe-sdk"></script>`;
      html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${head}`) : `${head}${html}`;
      return new NextResponse(html, { headers: { "Content-Type": contentType, "Cache-Control": "no-store" } });
    }
    const data = await fs.readFile(target);
    return new NextResponse(new Uint8Array(data), {
      headers: { "Content-Type": contentType, "Cache-Control": "no-store" },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
