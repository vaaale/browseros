// Core BrowserOS (BOS) types shared between server and client.
// Keep this module free of React and Node imports so it is safe everywhere.
// (pipeline test: harmless comment-only change, 2026-09-01.)
// (pipeline test 2: verifying the promote worktree-teardown race fix.)
// (pipeline test 3: verifying the async promote fix.)

export interface AppManifest {
  id: string;
  name: string;
  /** lucide-react icon name, e.g. "Folder" */
  icon: string;
  defaultWidth: number;
  defaultHeight: number;
  /** Desktop/dock sort key: lower sorts earlier; unset sorts last (then by name). */
  order?: number;
  /** Only one window instance allowed at a time. */
  singleton?: boolean;
  /** Built-in apps ship with the OS; others are installed at runtime. */
  builtin?: boolean;
  /** Hide from Dock/Desktop grid; launched programmatically via tools. */
  hidden?: boolean;
  /** How the app renders. "builtin" uses a React component; "iframe" loads a URL. */
  kind?: "builtin" | "iframe";
  /** For iframe apps: the URL to load (e.g. /apps/<id>/). */
  url?: string;
  /** For installed apps: path to the app entry inside the VFS. */
  source?: string;
  /** Capability grants for iframe apps — the set of BOS SDK APIs this app may call.
   *  Absent or empty means no BOS SDK access (plain sandboxed iframe). */
  capabilities?: AppCapability[];
  /** Provenance (028). Untrusted "marketplace" apps run in an OPAQUE-ORIGIN
   *  sandbox (broker is the only channel to BOS); "local"/absent apps keep the
   *  same-origin path. Builtin apps are native and unaffected. */
  origin?: "builtin" | "local" | "marketplace";
  /** For marketplace apps: the marketplace they came from. */
  marketplaceId?: string;
  /** 034-event-notification-system (FR-013): UI event handlers this app
   *  declares statically — launched when the user clicks a matching event in
   *  the Event Viewer. Surfaced into the handler registry at boot
   *  (src/lib/events/register-ui-handlers.ts). Headless handlers are NOT
   *  declared here — they are runtime-declared by running services (ADR-3). */
  eventHandlers?: AppEventHandlerDeclaration[];
  /** 034-event-notification-system: event-type namespace prefixes (each a
   *  "prefix.*" pattern or exact type) this app is interested in. **Advisory
   *  only since 037 (Event Namespace Relaxation)** — registration is no
   *  longer namespace-gated, so this documents intent rather than granting
   *  access. Any app may register a handler for any event type. */
  eventNamespaces?: string[];
  /** 036-file-type-handlers (FR-001): file types this app can render and/or
   *  edit. Declarative like `eventHandlers` above — the file-handler registry
   *  (src/lib/file-handlers/registry.ts) derives the "which apps open this
   *  type?" answer from every installed app's declarations, so registering a
   *  handler is a manifest edit with no core code change (FR-013). */
  fileHandlers?: AppFileHandlerDeclaration[];
}

/** One statically-declared UI event handler (AppManifest.eventHandlers). */
export interface AppEventHandlerDeclaration {
  /** Unique within this app — combined with the app id to form the global handlerId. */
  id: string;
  /** Event type this handler is launched for — exact type or a "prefix.*" pattern. */
  type: string;
  displayName: string;
  description?: string;
  /** lucide-react icon name; defaults to the app's own icon. */
  icon?: string;
}

/** What a file handler can do with a type: show it, change it, or both. */
export type FileHandlerCapability = "render" | "edit";

/** One statically-declared file-type handler (AppManifest.fileHandlers, 036).
 *  The OS hands the app a file through the open-file launch contract — see
 *  docs/dev/apps/file-handlers.md. */
export interface AppFileHandlerDeclaration {
  /** MIME type handled — an exact base type ("text/html") or a trailing-slash
   *  prefix covering a whole family ("image/"). Parameters are ignored on both
   *  sides of the match, so "text/html; charset=utf-8" matches "text/html". */
  type: string;
  /** "render" = can preview/display it; "edit" = can modify it. Only a
   *  render-capable handler may be the SELECTED (double-click) handler. */
  capabilities: FileHandlerCapability[];
  /** Shown as "Open with <label>"; defaults to the app's manifest `name`. */
  label?: string;
  /** Initial selected handler for the type, until the user picks another. */
  default?: boolean;
  /** Which contract fields this handler wants beyond the always-present
   *  `path` + `action`. A closed vocabulary the platform interprets uniformly —
   *  no per-app code in core. `url: "raw"` (the file's bytes URL) applies to
   *  built-in component handlers only: an iframe app's src is always its own
   *  `manifest.url`, so the OS never supplies it a url. */
  paramShape?: { url?: "raw"; title?: "basename" };
}

/** A BOS SDK capability that can be granted to a user-installed iframe app. */
export type AppCapability =
  | "fs:read"        // Read files from the user's VFS
  | "fs:write"       // Write files to the user's VFS
  | "settings:read"  // Read OS settings
  | "notify"         // Show desktop notifications via postMessage response
  | "window:title"   // Set the window title
  | "storage"        // Per-app persistent key/value store (backs the localStorage shim, 028)
  | "services:read"  // Read a service's config/runtime state (e.g. its bound port) — an
                     // opaque-origin app can't reach /api/services/* directly (no CORS,
                     // by design — see docs/dev/apps/services.md); this is the broker path
                     // a service's own bundled app (e.g. Terminal) needs to find its port.
  | "assistant";     // Drive the BOS assistant (040-assistant-broker-capability): start
                     // runs, stream their events, and answer frontend tool calls through
                     // the broker — the only path an opaque-origin app has to
                     // /api/assistant/* (same no-CORS reason as services:read). The app
                     // sees the events of runs IT starts (per-app run ownership), so this
                     // is a strictly stronger trust grant than the caps above: it is
                     // DECLARATION-GATED (grantable only if the app's app.json asks for
                     // it) — see docs/dev/assistant/assistant-broker.md.

export type WallpaperFit = "cover" | "contain";

export interface OSSettings {
  /** Wallpaper id (built-in gradient) or an image URL / VFS path. */
  wallpaper: string;
  wallpaperFit: WallpaperFit;
  accent: string;
  theme: "dark" | "light";
  /** Chat "normal" text font family id (see src/os/chat-fonts.ts). */
  chatFont: string;
  /** Chat "normal" text font size in px. Code blocks track this minus 1px. */
  chatFontSize: number;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowInstance extends WindowBounds {
  id: string;
  appId: string;
  title: string;
  zIndex: number;
  minimized: boolean;
  maximized: boolean;
  /** Kept above every unpinned window regardless of focus order. */
  alwaysOnTop?: boolean;
  /** Saved bounds to restore when un-maximizing. */
  prevBounds?: WindowBounds;
  /** Launch parameters handed to the app component. */
  params?: Record<string, unknown>;
}

/** Explicit launch geometry. Any field given is used verbatim, bypassing the
 *  default "80% of the viewport, centred" sizing — for windows whose size is
 *  dictated by their content (a video surface's aspect ratio) rather than by how
 *  much room a person needs to work in them. */
export interface WindowPlacement {
  width?: number;
  height?: number;
  x?: number;
  y?: number;
}

export type VfsNodeType = "file" | "dir";

export interface VfsEntry {
  name: string;
  /** POSIX-style absolute path within the VFS root, e.g. "/Documents/a.txt". */
  path: string;
  type: VfsNodeType;
  size: number;
  /** Last modified time, epoch milliseconds. */
  modified: number;
}
