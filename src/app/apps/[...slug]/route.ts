import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import * as esbuild from "esbuild";
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

// The SDK is inlined into every app HTML response so sub-resource requests are
// eliminated — required for opaque-origin sandboxed iframes whose sub-resource
// requests don't carry the bastion session cookie (SameSite=Lax) and would
// otherwise be redirected to the login page.
let sdkCache: string | null = null;
async function buildInlineSdk(): Promise<string> {
  if (sdkCache && process.env.NODE_ENV === "production") return sdkCache;
  const entry = path.join(process.cwd(), "src", "lib", "iframe-sdk", "index.ts");
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    write: false,
    minify: true,
    target: "es2020",
    logLevel: "silent",
  });
  sdkCache = result.outputFiles?.[0]?.text ?? "";
  return sdkCache;
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
    if (contentType.startsWith("text/html")) {
      let html = await fs.readFile(target, "utf8");

      // Build the SDK inline — eliminates the /api/iframe-sdk sub-resource request
      // which would fail auth in opaque-origin iframe contexts.
      const [snapshot, sdkJs] = await Promise.all([
        readAppStorage(id),
        buildInlineSdk(),
      ]);

      // Inline CSS if bundle.css exists next to the HTML — eliminates the
      // bundle.css sub-resource request for the same reason.
      const cssPath = path.join(root, "bundle.css");
      const cssContent = await fs.readFile(cssPath, "utf8").catch(() => null);

      // Inline JS if bundle.js exists — eliminates the bundle.js sub-resource.
      const jsPath = path.join(root, "bundle.js");
      const jsRaw = await fs.readFile(jsPath, "utf8").catch(() => null);
      // Escape </script> sequences inside the inline script to prevent early tag close.
      const jsContent = jsRaw ? jsRaw.replace(/<\/script>/gi, "<\\/script>") : null;

      // Head injection: base tag, storage snapshot, inline SDK, inline CSS.
      let headInject =
        `<base href="/apps/${id}/">` +
        `<script>window.__bos_storage_snapshot=${inlineJson(snapshot)};</script>` +
        `<script>${sdkJs}</script>`;
      if (cssContent !== null) {
        headInject += `<style>${cssContent}</style>`;
      }
      // Use a function replacement to prevent $& / $' / $` expansion in headInject.
      html = /<head[^>]*>/i.test(html)
        ? html.replace(/<head[^>]*>/i, (m) => `${m}${headInject}`)
        : `${headInject}${html}`;

      // Remove the now-redundant external <link> to bundle.css (already inlined).
      if (cssContent !== null) {
        html = html.replace(/<link\b[^>]*\bhref=["']bundle\.css["'][^>]*\/?>/gi, "");
      }

      // Replace <script src="bundle.js"> with the inline script.
      // Use a function replacement — string replacements interpret $& / $' / $`
      // as special patterns, and minified JS bundles routinely contain $& which
      // would expand to the matched tag text, corrupting the output.
      if (jsContent !== null) {
        html = html.replace(
          /<script\b[^>]*\bsrc=["']bundle\.js["'][^>]*><\/script>/gi,
          () => `<script>${jsContent}</script>`,
        );
      }

      // Remove any remaining external <script src="/api/iframe-sdk"> (now inlined above).
      html = html.replace(/<script\b[^>]*\bsrc=["'][^"']*api\/iframe-sdk["'][^>]*><\/script>/gi, "");

      return new NextResponse(html, {
        headers: { "Content-Type": contentType, "Cache-Control": "no-store" },
      });
    }
    const data = await fs.readFile(target);
    return new NextResponse(new Uint8Array(data), {
      headers: { "Content-Type": contentType, "Cache-Control": "no-store" },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
