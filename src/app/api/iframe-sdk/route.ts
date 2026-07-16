import "server-only";
import * as esbuild from "esbuild";
import path from "node:path";

// Serves the BOS iframe SDK as JavaScript at /api/iframe-sdk. The SDK source is a
// TypeScript library (src/lib/iframe-sdk/) bundled here with esbuild (IIFE) —
// promoted from a hard-coded string (028) so it can grow (storage shim,
// capability introspection) with type-checking and without hand-maintaining a
// template literal. Built once and cached in production; rebuilt per request in
// dev so edits show up on reload.
//
// NOTE: this lives under /api (routable) rather than the old /__bos/sdk.js — the
// `__bos` folder was underscore-prefixed (a Next PRIVATE folder), so that route
// never actually registered and the SDK was never served. The app-serving route
// injects <script src="/api/iframe-sdk"> so apps get window.__bos.
export const dynamic = "force-dynamic";

const ENTRY = path.join(process.cwd(), "src", "lib", "iframe-sdk", "index.ts");
let cached: string | null = null;

async function buildSdk(): Promise<string> {
  if (cached && process.env.NODE_ENV === "production") return cached;
  const result = await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    format: "iife",
    write: false,
    minify: true,
    target: "es2020",
    logLevel: "silent",
  });
  cached = result.outputFiles?.[0]?.text ?? "";
  return cached;
}

export async function GET() {
  const sdk = await buildSdk();
  return new Response(sdk, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
