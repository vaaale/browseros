import { NextRequest } from "next/server";
import { serveVfsFile } from "@/lib/files/serve";
import { withFeatureScope, scopeFromRequest } from "@/lib/specs/feature-context";

// The PATH-SHAPED raw-file URL: `/api/fs/raw/Documents/report.html` serves
// exactly what `/api/fs/raw?path=/Documents/report.html` serves.
//
// Why both shapes exist: a browser resolves a document's RELATIVE references
// against the directory of the URL it was loaded from, and a query string has no
// directory. Loaded as `/api/fs/raw?path=/Documents/site/index.html`, the
// document's `<link href="style.css">` resolves to `/api/fs/style.css` — a 404 —
// so an HTML file that keeps its CSS/JS beside it previewed unstyled, or
// completely blank when a relative script builds the page. Loaded from this
// route, the same reference resolves to `/api/fs/raw/Documents/site/style.css`,
// which is this route again, serving the sibling file.
//
// So: this shape is for DOCUMENTS (html-viewer's iframe src, via `rawUrlFor` —
// see src/os/file-handlers.ts). The query shape stays the general-purpose one
// for single-asset consumers (images, wallpapers, attachments, downloads), which
// have no relative references and whose URLs are built in a dozen places.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  // Next.js has already percent-decoded each segment, so joining them yields
  // the VFS path verbatim — including spaces and "#". Escapes ("..") are the
  // VFS's own business: vfs.ts rejects any path leaving the root.
  const { path: segments } = await ctx.params;
  const vfsPath = "/" + (segments ?? []).join("/");
  const { searchParams } = new URL(req.url);
  // Scope travels as a query param here for the same reason as on the query
  // shape: this route is loaded by plain browser navigation (an <iframe src>),
  // which cannot set the header the fetch()-based fs client uses.
  return withFeatureScope(scopeFromRequest(req.headers, searchParams), () => serveVfsFile(vfsPath));
}
