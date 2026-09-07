// 036-file-type-handlers: the pure half of the file-handler mechanism.
// Framework-free — no React, no Node, no "server-only" — because BOTH sides
// need it: the server registry matches manifests against a file's type, and the
// CLIENT Files app assembles the launch params (`launch` is the client store, so
// the caller that builds them is always client code) and cannot import a
// server-only module. Anything that reads the installed-app set or durable
// state lives in src/lib/file-handlers/ instead.

import type { AppFileHandlerDeclaration, FileHandlerCapability } from "./types";

// THE map for handler matching. Deliberately not the larger one in
// src/lib/files/serve.ts — that one is a *serving* concern (the Content-Type of
// streamed bytes) and belongs to the raw-file route. An extension missing here
// resolves to application/octet-stream and so matches no handler; the fix is to
// add a line here, never to import the serving map.
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

/** The extension of a POSIX-ish path, lowercased and dot-prefixed ("" if none).
 *  Hand-rolled rather than `path.extname` so this module stays Node-free. */
function extname(p: string): string {
  const base = p.slice(p.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/** The full MIME type for a path, parameters included ("text/html; charset=utf-8"). */
export function mimeForPath(p: string): string {
  return MIME[extname(p)] ?? "application/octet-stream";
}

/** A MIME type reduced to its base media type: parameters dropped, lowercased.
 *  Manifests declare bare types, `mimeForPath` returns parameterized ones — so
 *  every comparison and every selection key goes through here first. */
export function baseMime(mime: string): string {
  return mime.split(";")[0].trim().toLowerCase();
}

/** The base media type of a file path — what handler matching keys on. */
export function fileBaseMime(p: string): string {
  return baseMime(mimeForPath(p));
}

/** The URL a handler LOADS A DOCUMENT FROM — the PATH-shaped raw-file URL
 *  (`/api/fs/raw/Documents/site/index.html`), not `fsClient.rawUrl`'s query
 *  shape.
 *
 *  The shape is the whole point: a browser resolves a document's relative
 *  references against the directory of the URL it was loaded from, and a query
 *  string has no directory. Served as `/api/fs/raw?path=…`, an HTML file's
 *  `<link href="style.css">` resolved to `/api/fs/style.css` and 404'd — so a
 *  page that keeps its CSS/JS beside it previewed unstyled, and one whose body
 *  is built by a relative script previewed blank ("I opened an HTML file and it
 *  didn't render"). From this shape, the sibling resolves to
 *  `/api/fs/raw/Documents/site/style.css` — the same route, serving it.
 *
 *  Lives here rather than in os-client.ts because that module touches
 *  `document`/`XMLHttpRequest`, and this builder must stay importable by the
 *  server too. Each segment is encoded individually: a path segment may contain
 *  "#", "?" or a space, none of which may reach the URL literally. */
export function rawUrlFor(path: string): string {
  const segments = path.split("/").filter(Boolean).map(encodeURIComponent);
  return `/api/fs/raw/${segments.join("/")}`;
}

/** The last segment of a VFS path. */
export function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1) || p;
}

/** One handler as the Files app sees it: enough to draw the row and launch it.
 *  Built by the server registry (src/lib/file-handlers/registry.ts) and sent
 *  over /api/file-handlers, so the shape lives here where both sides can name
 *  it without the client reaching into a server-only module. */
export interface FileHandlerView {
  appId: string;
  /** The app's manifest name — the fallback label and the window title. */
  name: string;
  /** The TARGET APP's own manifest icon, never a semantic glyph (FR-008). */
  icon: string;
  /** What "Open with <…>" says: the declared label, else the app name. */
  label: string;
  capabilities: FileHandlerCapability[];
  /** Declared `default: true` in the manifest. */
  isDefault: boolean;
  /** This is the handler double-click currently uses (at most one is true). */
  selected: boolean;
  /** The declaration itself, so the client can build the launch params. */
  decl: AppFileHandlerDeclaration;
}

/** The registry's answer for one MIME type — the body of GET/POST
 *  /api/file-handlers. */
export interface FileHandlerListing {
  mime: string;
  handlers: FileHandlerView[];
  /** App id of the handler double-click uses, or null to fall back in-app. */
  selected: string | null;
}

/** What the OS hands a handler when opening a file with it. */
export interface FileLaunchParams extends Record<string, unknown> {
  /** The file's VFS path — always present. */
  path: string;
  /** What the user asked for: preview it, or edit it. Always present. */
  action: "open" | "edit";
  /** The raw-bytes URL, only for a built-in handler declaring `url: "raw"`. */
  url?: string;
  /** The file's basename, only for a handler declaring `title: "basename"`. */
  title?: string;
}

/** The open-file launch contract (FR-014): turn a handler's declaration plus
 *  the file the user clicked into the params for `launch(appId, params)`.
 *  Generic by construction — `paramShape` is a closed vocabulary, so adding a
 *  handler never touches this function. See docs/dev/apps/file-handlers.md. */
export function buildLaunchParams(
  decl: AppFileHandlerDeclaration | undefined,
  path: string,
  action: "open" | "edit",
): FileLaunchParams {
  const params: FileLaunchParams = { path, action };
  if (decl?.paramShape?.url === "raw") params.url = rawUrlFor(path);
  if (decl?.paramShape?.title === "basename") params.title = basename(path);
  return params;
}
