import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { writeFileAtomic } from "@/os/atomic-write";
import * as vfs from "@/os/vfs";
import type { AppManifest } from "@/os/types";

const FILE = path.join(dataDir(), "installed-apps.json");

export type AppStatus = "installed" | "uninstalled";

export interface InstalledApp {
  id: string;
  name: string;
  icon: string;
  createdAt: number;
  /** VFS directory holding the app, e.g. /Apps/<id>. */
  dir: string;
  /**
   * "installed" apps appear on the desktop. "uninstalled" apps are hidden but
   * keep their files so they can be restored; purgeApp removes the files.
   */
  status: AppStatus;
  uninstalledAt?: number;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `app-${Date.now().toString(36)}`;
}

// Choose an appropriate lucide icon name from the app name/spec keywords.
const ICON_RULES: [RegExp, string][] = [
  [/timer|pomodoro|stopwatch/, "Timer"],
  [/clock|time|alarm/, "Clock"],
  [/calc|math/, "Calculator"],
  [/todo|task|checklist/, "ListTodo"],
  [/note|memo|scratch/, "StickyNote"],
  [/calendar|schedule|agenda/, "Calendar"],
  [/music|audio|sound|player/, "Music"],
  [/image|photo|gallery|paint|draw|canvas/, "Image"],
  [/mail|email|inbox/, "Mail"],
  [/chat|message|messenger/, "MessageSquare"],
  [/map|location|geo/, "Map"],
  [/game|play|arcade/, "Gamepad2"],
  [/weather|forecast|cloud/, "Cloud"],
  [/news|feed|rss|article/, "Newspaper"],
  [/doc|documentation|manual|guide|book/, "BookOpen"],
  [/code|editor|terminal|dev/, "Code2"],
  [/file|folder|explorer/, "Folder"],
  [/web|browser|site|url/, "Globe"],
  [/text|writer|word|markdown/, "FileText"],
];

export function pickIcon(name: string, spec = ""): string {
  const hay = `${name} ${spec}`.toLowerCase();
  for (const [re, icon] of ICON_RULES) if (re.test(hay)) return icon;
  return "Puzzle";
}

async function readAll(): Promise<InstalledApp[]> {
  try {
    const apps = JSON.parse(await fs.readFile(FILE, "utf8")) as InstalledApp[];
    // Records written before soft-uninstall existed have no status; treat as installed.
    return apps.map((a) => ({ ...a, status: a.status ?? "installed" }));
  } catch {
    return [];
  }
}

async function writeAll(apps: InstalledApp[]): Promise<void> {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await writeFileAtomic(FILE, JSON.stringify(apps, null, 2));
}

/** Convert an installed app into an OS app manifest (rendered as an iframe). */
export function toManifest(app: InstalledApp): AppManifest {
  return {
    id: app.id,
    name: app.name,
    icon: app.icon,
    defaultWidth: 800,
    defaultHeight: 600,
    builtin: false,
    kind: "iframe",
    url: `/apps/${app.id}`,
    source: app.dir,
  };
}

export async function listInstalledApps(): Promise<InstalledApp[]> {
  return readAll();
}

/** Manifests for the desktop — only currently-installed apps (uninstalled ones are hidden). */
export async function listInstalledManifests(): Promise<AppManifest[]> {
  return (await readAll()).filter((a) => a.status === "installed").map(toManifest);
}

/**
 * Install an app from a set of files. `index.html` is required and becomes the
 * entry point. Files are written into the VFS at /Apps/<id> and served from
 * /apps/<id>/ so the app can call BrowserOS APIs (same-origin).
 */
export async function installApp(input: {
  name: string;
  icon?: string;
  files: Record<string, string>;
}): Promise<AppManifest> {
  if (!input.files["index.html"]) throw new Error("An index.html file is required");
  const apps = await readAll();
  const id = slugify(input.name);
  const dir = `/Apps/${id}`;

  for (const [rel, content] of Object.entries(input.files)) {
    await vfs.writeText(`${dir}/${rel}`, content);
  }

  const app: InstalledApp = { id, name: input.name, icon: input.icon || "Puzzle", createdAt: Date.now(), dir, status: "installed" };
  await writeAll([...apps.filter((a) => a.id !== id), app]);
  return toManifest(app);
}

/** Soft uninstall: hide the app from the desktop but keep its files for restore. */
export async function uninstallApp(id: string): Promise<InstalledApp[]> {
  const next = (await readAll()).map((a) =>
    a.id === id ? { ...a, status: "uninstalled" as AppStatus, uninstalledAt: Date.now() } : a,
  );
  await writeAll(next);
  return next;
}

/** Restore a previously uninstalled app (its files were kept). */
export async function restoreApp(id: string): Promise<AppManifest | undefined> {
  const apps = await readAll();
  const app = apps.find((a) => a.id === id);
  if (!app) return undefined;
  const restored: InstalledApp = { ...app, status: "installed", uninstalledAt: undefined };
  await writeAll(apps.map((a) => (a.id === id ? restored : a)));
  return toManifest(restored);
}

/** Permanently delete an app's record and its files. */
export async function purgeApp(id: string): Promise<InstalledApp[]> {
  const next = (await readAll()).filter((a) => a.id !== id);
  await writeAll(next);
  await vfs.remove(`/Apps/${id}`).catch(() => {});
  return next;
}
