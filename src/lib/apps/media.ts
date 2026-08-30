// Framework-free media classification for the `web_view` tool (no React, no
// server-only): the v2 handler (components/agent/v2/FrontendToolsV2.tsx) and the
// v1 handler (components/agent/OSActions.tsx) both import it so their notion of
// "this target is an image / a video" cannot drift. The extension sets mirror
// the raw-file route's MIME map (src/app/api/fs/raw/route.ts) — keep them in
// sync, otherwise the tool claims a target is video while the route serves it as
// application/octet-stream and the preview dead-ends in an error card.

export type MediaType = "image" | "video";

export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"]);
export const VIDEO_EXTENSIONS = new Set(["mp4", "ogv", "webm", "mov", "m4v", "avi"]);

/** `image/png` → "image", `video/mp4` → "video", anything else → null. */
export function mediaTypeFromMime(mime: string): MediaType | null {
  const value = mime.trim().toLowerCase();
  if (value.startsWith("image/")) return "image";
  if (value.startsWith("video/")) return "video";
  return null;
}

/**
 * Classify a resolved `web_view` target as image, video, or non-media (null →
 * render as a document in the existing iframe). Handles the shapes a target can
 * take by the time the handler has resolved it: `/api/fs/raw?path=…` (classify
 * the VFS path, not the route), a `data:` URI (classify the MIME prefix), any
 * other URL or path (classify the pathname extension), and a virtual media
 * endpoint whose pathname carries no extension at all (classify the filename
 * hiding in the query string — see `mediaSourceOf`).
 */
export function classifyMediaTarget(src: string): MediaType | null {
  const value = typeof src === "string" ? src.trim() : "";
  if (!value) return null;
  if (value.toLowerCase().startsWith("data:")) {
    return mediaTypeFromMime(value.slice(5).split(/[;,]/)[0] ?? "");
  }
  return typeFromExtension(mediaSourceOf(value));
}

/**
 * A short human label for a target, used for the default window title and the
 * in-window "Could not load" card: the file's basename when it has one, else the
 * URL itself (a `data:` URI collapses to its MIME prefix — the payload is
 * megabytes of base64 and useless in an error message). Reads the same source as
 * the classifier, so a virtual endpoint is titled `clip.mp4` rather than `view`.
 */
export function mediaTargetLabel(src: string): string {
  const value = typeof src === "string" ? src.trim() : "";
  if (!value) return "";
  if (value.toLowerCase().startsWith("data:")) {
    const mime = value.slice(5).split(/[;,]/)[0] ?? "";
    return mime ? `data:${mime}` : "data URI";
  }
  const source = mediaSourceOf(value);
  const base = source.slice(source.lastIndexOf("/") + 1);
  return base || value;
}

// Query params that carry the real filename on a "virtual" media endpoint — a
// route like ComfyUI's `/view?filename=clip.mp4&subfolder=video&type=output`,
// where the pathname says nothing about the media type. Checked in this order,
// most explicit first.
const FILENAME_PARAMS = ["filename", "file", "path", "name"];

// The path-like string a target's extension and label should be read from: the
// pathname when it has a media extension, else a filename found in the query
// string (virtual endpoint), else the pathname again so a non-media target is
// classified and labelled exactly as before.
function mediaSourceOf(value: string): string {
  const pathname = pathnameOf(value);
  if (typeFromExtension(pathname)) return pathname;
  return queryMediaSourceOf(value) ?? pathname;
}

// A query param value that names media, or null. Tries the well-known filename
// params first, then scans every param as a last resort — a virtual endpoint may
// spell it anything (`?f=clip.mp4`), and a value only counts when its extension
// is one we can actually render, so a stray `?redirect=/home` never wins.
function queryMediaSourceOf(value: string): string | null {
  const url = parseUrl(value);
  if (!url) return null;
  for (const key of FILENAME_PARAMS) {
    const param = url.searchParams.get(key);
    if (param && typeFromExtension(param)) return param;
  }
  for (const param of url.searchParams.values()) {
    if (typeFromExtension(param)) return param;
  }
  return null;
}

// The path portion a target's extension should be read from: the `path` query
// param for the raw-file route (whose own pathname has no extension), the
// pathname for everything else.
function pathnameOf(value: string): string {
  const url = parseUrl(value);
  if (!url) return value.split(/[?#]/)[0] ?? value;
  if (url.pathname.startsWith("/api/fs/raw")) return url.searchParams.get("path") ?? url.pathname;
  return url.pathname;
}

function parseUrl(value: string): URL | null {
  try {
    // A relative target (/Pictures/chart.png) needs a base; it is never used.
    return new URL(value, "http://browseros.invalid");
  } catch {
    return null;
  }
}

function typeFromExtension(pathname: string): MediaType | null {
  const base = pathname.slice(pathname.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot < 1) return null; // no extension, or a dotfile like ".gitignore"
  const ext = base.slice(dot + 1).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  return null;
}

// The same-origin route that re-serves external media
// (src/app/api/media-proxy/route.ts).
const MEDIA_PROXY_ROUTE = "/api/media-proxy";

/**
 * True when a resolved media target has to be re-served through BOS's media
 * proxy: an absolute `http(s)://` URL whose origin is not the page's own. A
 * relative/same-origin target (`/api/fs/raw?path=…`) and a `data:` URI are
 * already same-origin or inline, so they are left alone (A-8).
 *
 * The reason external media cannot be pointed at directly: when BOS itself is
 * served over HTTPS the browser blocks an `http://` media element as mixed
 * content, and it does so before the element ever fires a request — so the
 * viewer shows an error card for a URL that is perfectly alive (SC-006).
 */
export function needsProxy(url: string): boolean {
  const value = typeof url === "string" ? url.trim() : "";
  if (!/^https?:\/\//i.test(value)) return false;
  // Client-only comparison; on the server there is no page origin to compare
  // against, and this module is imported by framework-free callers.
  if (typeof window === "undefined") return false;
  try {
    return new URL(value).origin !== window.location.origin;
  } catch {
    return false;
  }
}

/**
 * A media URL the viewer can safely put in an `<img>`/`<video>`: external URLs
 * routed through the proxy, everything else unchanged. Both `web_view` handlers
 * (v2 FrontendToolsV2.tsx, v1 OSActions.tsx) call this so the proxy route path
 * lives in exactly one place. Classify and label the ORIGINAL target before
 * calling it — the proxied URL is about transport, not about what the target is.
 */
export function proxiedMediaUrl(url: string): string {
  return needsProxy(url) ? `${MEDIA_PROXY_ROUTE}?src=${encodeURIComponent(url)}` : url;
}
