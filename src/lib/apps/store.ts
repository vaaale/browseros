import "server-only";
import { promises as fs } from "fs";
import path from "path";
import * as vfs from "@/os/vfs";
import type { AppManifest } from "@/os/types";

const FILE = path.join(process.cwd(), "data", "installed-apps.json");

export interface InstalledApp {
  id: string;
  name: string;
  icon: string;
  createdAt: number;
  /** VFS directory holding the app, e.g. /Apps/<id>. */
  dir: string;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `app-${Date.now().toString(36)}`;
}

async function readAll(): Promise<InstalledApp[]> {
  try {
    return JSON.parse(await fs.readFile(FILE, "utf8")) as InstalledApp[];
  } catch {
    return [];
  }
}

async function writeAll(apps: InstalledApp[]): Promise<void> {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(apps, null, 2), "utf8");
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

export async function listInstalledManifests(): Promise<AppManifest[]> {
  return (await readAll()).map(toManifest);
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

  const app: InstalledApp = { id, name: input.name, icon: input.icon || "Puzzle", createdAt: Date.now(), dir };
  await writeAll([...apps.filter((a) => a.id !== id), app]);
  return toManifest(app);
}

export async function uninstallApp(id: string): Promise<InstalledApp[]> {
  const next = (await readAll()).filter((a) => a.id !== id);
  await writeAll(next);
  await vfs.remove(`/Apps/${id}`).catch(() => {});
  return next;
}
