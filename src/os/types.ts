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
