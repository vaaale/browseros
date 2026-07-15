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
}

/** A BOS SDK capability that can be granted to a user-installed iframe app. */
export type AppCapability =
  | "fs:read"       // Read files from the user's VFS
  | "fs:write"      // Write files to the user's VFS
  | "settings:read" // Read OS settings
  | "notify"        // Show desktop notifications via postMessage response
  | "window:title"; // Set the window title

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
  /** Saved bounds to restore when un-maximizing. */
  prevBounds?: WindowBounds;
  /** Launch parameters handed to the app component. */
  params?: Record<string, unknown>;
}

// A Feature Context (027-vfs-specfs) scopes all spec + source changes belonging
// to one development effort. The branch name `bos/feat/<id>` is the correlation
// key across the user-specs repo and the BOS source repo. Exactly one context is
// active per BOS instance at a time; it is persisted server-side so SpecFS can
// read it without a client round-trip.
export interface FeatureContext {
  /** User-chosen slug, validated `^[a-z0-9-]+$`. */
  id: string;
  /** Derived branch name, always `bos/feat/<id>`. */
  branchName: string;
  description?: string;
  /** VFS paths of spec folders written under this feature. */
  touchedSpecs: string[];
  /** BOS source paths modified under this feature. */
  touchedSourcePaths: string[];
  /** ISO-8601 creation timestamp. */
  startedAt: string;
}

export interface FeatureContextFile {
  active: FeatureContext | null;
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
