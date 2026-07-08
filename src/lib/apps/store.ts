import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { appsDir } from "@/os/apps-dir";
import { writeFileAtomic } from "@/os/atomic-write";
import { ensureRepo, commitAll } from "@/lib/gitfs/store";
import { buildAppDir } from "@/lib/apps/build";
import { supervisorEnabled, supervisorAppBegin } from "@/lib/devharness/supervisor";
import type { AppManifest, AppCapability } from "@/os/types";

// Installed apps are versioned *content* in a standalone git repo (GitFS) rooted
// at appsDir(). There is NO central registry file: each app is a self-contained
// directory `<appsDir>/<id>/` holding its files (entry `index.html`) plus an
// `app.json` manifest. Apps are DISCOVERED by listing that directory — which is
// what keeps them additive, conflict-free on upstream merges, and ready for a
// community marketplace (an app = a portable, self-describing folder).

const MANIFEST = "app.json";

export type AppStatus = "installed" | "uninstalled";

export interface InstalledApp {
  id: string;
  name: string;
  icon: string;
  createdAt: number;
  /** App directory relative to the apps root, e.g. /<id>. */
  dir: string;
  /**
   * "installed" apps appear on the desktop. "uninstalled" apps are hidden but
   * keep their files so they can be restored; purgeApp removes the files.
   */
  status: AppStatus;
  uninstalledAt?: number;
  /** For built projects: the source entry (e.g. "src/main.tsx") esbuild bundles into dist/. Absent for plain static apps. */
  entry?: string;
  /** BOS SDK capability grants for this app. Absent/empty = plain sandboxed iframe, no BOS API access. */
  capabilities?: AppCapability[];
}

function root(): string {
  return appsDir();
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

export async function readApp(id: string): Promise<InstalledApp | null> {
  try {
    const raw = await fs.readFile(path.join(root(), id, MANIFEST), "utf8");
    const m = JSON.parse(raw) as Partial<InstalledApp>;
    return {
      id,
      name: typeof m.name === "string" ? m.name : id,
      icon: typeof m.icon === "string" ? m.icon : "Puzzle",
      createdAt: typeof m.createdAt === "number" ? m.createdAt : 0,
      dir: `/${id}`,
      status: m.status === "uninstalled" ? "uninstalled" : "installed",
      uninstalledAt: typeof m.uninstalledAt === "number" ? m.uninstalledAt : undefined,
      entry: typeof m.entry === "string" ? m.entry : undefined,
      capabilities: Array.isArray(m.capabilities) ? (m.capabilities as AppCapability[]) : undefined,
    };
  } catch {
    return null;
  }
}

/** Discover all apps by listing the apps repo (each app dir has an app.json). */
async function readAll(): Promise<InstalledApp[]> {
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(root(), { withFileTypes: true });
  } catch {
    return [];
  }
  const ids = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
  const apps = await Promise.all(ids.map(readApp));
  return apps.filter((a): a is InstalledApp => a !== null).sort((a, b) => a.createdAt - b.createdAt);
}

async function writeManifest(app: InstalledApp): Promise<void> {
  const { dir: _dir, ...rest } = app;
  void _dir;
  await writeFileAtomic(path.join(root(), app.id, MANIFEST), JSON.stringify(rest, null, 2));
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
    capabilities: app.capabilities,
  };
}

export async function listInstalledApps(): Promise<InstalledApp[]> {
  return readAll();
}

/** Build an app's dist/ if it has an entry point but hasn't been built yet. */
async function ensureBuilt(app: InstalledApp): Promise<void> {
  if (!app.entry) return;
  const distIndex = path.join(root(), app.id, "dist", "index.html");
  const built = await fs.access(distIndex).then(() => true).catch(() => false);
  if (!built) await buildAppDir(path.join(root(), app.id), app.entry, app.name);
}

/** Manifests for the desktop — only currently-installed apps (uninstalled ones are hidden). */
export async function listInstalledManifests(): Promise<AppManifest[]> {
  const installed = (await readAll()).filter((a) => a.status === "installed");
  await Promise.allSettled(installed.map(ensureBuilt));
  return installed.map(toManifest);
}

/**
 * Install an app from a set of files. `index.html` is required and becomes the
 * entry point. Files are written into the apps repo at <appsDir>/<id> and served
 * from /apps/<id>/ (same-origin, so the app can call BrowserOS APIs). The change
 * is committed to GitFS.
 */
export async function installApp(
  input: {
    name: string;
    icon?: string;
    files: Record<string, string>;
    /** Built project: source entry (e.g. "src/main.tsx") esbuild bundles into dist/. If set, an index.html is generated and not required in files. */
    entry?: string;
    /** BOS SDK capability grants. Absent = no BOS SDK access. */
    capabilities?: AppCapability[];
  },
  opts?: { draft?: boolean },
): Promise<AppManifest> {
  if (!input.entry && !input.files["index.html"]) {
    throw new Error("Provide either an index.html (static app) or an entry (built project)");
  }
  const r = root();
  await ensureRepo(r);
  // Draft install (under the Supervisor): check out the app-candidate branch
  // first, so this install lands on it (previewable) instead of going live. The
  // user then promotes or discards via the version controls. Outside the
  // Supervisor this is a no-op and the app installs live.
  if (opts?.draft && supervisorEnabled()) {
    await supervisorAppBegin();
  }
  const id = slugify(input.name);
  const dir = path.join(r, id);

  for (const [rel, content] of Object.entries(input.files)) {
    await writeFileAtomic(path.join(dir, rel), content);
  }

  // Built project: bundle the source entry into dist/ (served instead of the raw files).
  if (input.entry) {
    await buildAppDir(dir, input.entry, input.name);
  }

  const app: InstalledApp = {
    id,
    name: input.name,
    icon: input.icon || pickIcon(input.name),
    createdAt: Date.now(),
    dir: `/${id}`,
    status: "installed",
    entry: input.entry,
    capabilities: input.capabilities,
  };
  await writeManifest(app);
  await commitAll(r, `install app ${id}${opts?.draft ? " (draft)" : ""}`);
  return toManifest(app);
}

/** Soft uninstall: hide the app from the desktop but keep its files for restore. */
export async function uninstallApp(id: string): Promise<InstalledApp[]> {
  const app = await readApp(id);
  if (app) {
    await writeManifest({ ...app, status: "uninstalled", uninstalledAt: Date.now() });
    await commitAll(root(), `uninstall app ${id}`);
  }
  return readAll();
}

/** Restore a previously uninstalled app (its files were kept). */
export async function restoreApp(id: string): Promise<AppManifest | undefined> {
  const app = await readApp(id);
  if (!app) return undefined;
  const restored: InstalledApp = { ...app, status: "installed", uninstalledAt: undefined };
  await writeManifest(restored);
  await commitAll(root(), `restore app ${id}`);
  return toManifest(restored);
}

/** Update the capability grants for an installed app. */
export async function setAppCapabilities(id: string, capabilities: AppCapability[]): Promise<AppManifest | undefined> {
  const app = await readApp(id);
  if (!app) return undefined;
  const updated: InstalledApp = { ...app, capabilities };
  await writeManifest(updated);
  await commitAll(root(), `update capabilities for app ${id}`);
  return toManifest(updated);
}

/** Permanently delete an app's directory and commit the removal. */
export async function purgeApp(id: string): Promise<InstalledApp[]> {
  await fs.rm(path.join(root(), id), { recursive: true, force: true }).catch(() => {});
  await commitAll(root(), `purge app ${id}`);
  return readAll();
}
