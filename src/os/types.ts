// Core BrowserOS (BOS) types shared between server and client.
// Keep this module free of React and Node imports so it is safe everywhere.

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
  /** 034-event-notification-system (FR-023): statically-granted event-type
   *  namespace prefixes (each a "prefix.*" pattern or exact type) this app
   *  may register handlers for, beyond its own owned root
   *  (`com.bos.<id>.*`). Absent ⇒ no extra grants. */
  eventNamespaces?: string[];
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
