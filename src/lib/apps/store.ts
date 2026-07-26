import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { writeFileAtomic } from "@/os/atomic-write";
import { ensureRepo, commitAll } from "@/lib/gitfs/store";
import { buildAppDir } from "@/lib/apps/build";
import { supervisorEnabled, supervisorAppBegin } from "@/lib/devharness/supervisor";
import { createAppSymlink, removeAppSymlink } from "@/system/marketplace/install/symlinkManager";
import type { AppManifest, AppCapability } from "@/os/types";

// Installed apps are the `app/` facet of an ITEM (user-specs/002-service-daemons):
// a self-contained folder `dataDir()/user-apps/<id>/` — the user's own GitFS
// repo, aka the local marketplace — that may bundle any mix of app/, services/,
// hooks/, config/, spec/, doc/. "Installed" means the item's app/ is symlinked
// at dataDir()/system/app/<id> (the same item-to-system mapping services use);
// the desktop discovers apps by listing those symlinks, and /apps/<id>/ serves
// through them. There is NO central registry and no separate apps repo: soft
// uninstall just removes the symlink (files stay, restorable), purge deletes
// the item folder from user-apps/.

const MANIFEST = "app.json";

export type AppStatus = "installed" | "uninstalled";

export interface InstalledApp {
  id: string;
  name: string;
  icon: string;
  createdAt: number;
  /** Item app directory relative to user-apps/, e.g. /<id>/app. */
  dir: string;
  /**
   * "installed" apps appear on the desktop (system/app/<id> symlink exists).
   * "uninstalled" items keep their files under user-apps/<id>/ so they can be
   * restored; purgeApp removes the files.
   */
  status: AppStatus;
  /** For built projects: the source entry (e.g. "src/main.tsx") esbuild bundles into dist/. Absent for plain static apps. */
  entry?: string;
  /** BOS SDK capability grants for this app. Absent/empty = plain sandboxed iframe, no BOS API access. */
  capabilities?: AppCapability[];
  /** Provenance (028): "marketplace" apps are untrusted → opaque-origin sandbox. Absent = "local". */
  origin?: "local" | "marketplace";
  /** For marketplace apps: the source marketplace id. */
  marketplaceId?: string;
}

const itemsRoot = () => path.join(dataDir(), "user-apps");
const sysAppRoot = () => path.join(dataDir(), "system", "app");
const itemAppDir = (id: string) => path.join(itemsRoot(), id, "app");
const linkPath = (id: string) => path.join(sysAppRoot(), id);

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `app-${Date.now().toString(36)}`;
}

function toDisplayName(id: string): string {
  return id.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
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

async function pathExists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}

/** True when the item's app is installed (its system/app/<id> symlink exists
 *  AND resolves — a dangling link, e.g. after a discarded draft, counts as
 *  not installed). */
async function isAppInstalled(id: string): Promise<boolean> {
  return pathExists(linkPath(id));
}

/** Fallback name for items that ship no app.json: their service.json name, or
 *  a prettified id. */
async function fallbackName(id: string): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(itemsRoot(), id, "services", "service.json"), "utf8");
    const m = JSON.parse(raw) as { name?: unknown };
    if (typeof m.name === "string" && m.name.trim()) return m.name;
  } catch {
    // no service.json — fall through
  }
  return toDisplayName(id);
}

export async function readApp(id: string): Promise<InstalledApp | null> {
  const appDir = itemAppDir(id);
  // The app facet exists if the item ships a servable UI: a manifest, a static
  // index.html, or a built dist/.
  const hasManifest = await pathExists(path.join(appDir, MANIFEST));
  const hasHtml = hasManifest
    || (await pathExists(path.join(appDir, "index.html")))
    || (await pathExists(path.join(appDir, "dist", "index.html")));
  if (!hasHtml) return null;

  let m: Partial<InstalledApp> = {};
  if (hasManifest) {
    try {
      m = JSON.parse(await fs.readFile(path.join(appDir, MANIFEST), "utf8")) as Partial<InstalledApp>;
    } catch {
      // malformed app.json — treat as metadata-less
    }
  }
  const name = typeof m.name === "string" && m.name.trim() ? m.name : await fallbackName(id);
  return {
    id,
    name,
    icon: typeof m.icon === "string" ? m.icon : pickIcon(name),
    createdAt: typeof m.createdAt === "number" ? m.createdAt : 0,
    dir: `/${id}/app`,
    status: (await isAppInstalled(id)) ? "installed" : "uninstalled",
    entry: typeof m.entry === "string" ? m.entry : undefined,
    capabilities: Array.isArray(m.capabilities) ? (m.capabilities as AppCapability[]) : undefined,
    origin: m.origin === "marketplace" ? "marketplace" : undefined,
    marketplaceId: typeof m.marketplaceId === "string" ? m.marketplaceId : undefined,
  };
}

/** Discover all app-carrying items by listing user-apps/. */
async function readAll(): Promise<InstalledApp[]> {
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(itemsRoot(), { withFileTypes: true });
  } catch {
    return [];
  }
  const ids = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
  const apps = await Promise.all(ids.map(readApp));
  return apps.filter((a): a is InstalledApp => a !== null).sort((a, b) => a.createdAt - b.createdAt);
}

async function writeManifest(app: InstalledApp): Promise<void> {
  const { dir: _dir, status: _status, ...rest } = app;
  void _dir; void _status;
  await writeFileAtomic(path.join(itemAppDir(app.id), MANIFEST), JSON.stringify(rest, null, 2));
}

/** Convert an installed app into an OS app manifest (rendered as an iframe). */
export function toManifest(app: InstalledApp): AppManifest {
  return {
    id: app.id,
    name: app.name,
    icon: app.icon,
    defaultWidth: 1000,
    defaultHeight: 700,
    builtin: false,
    kind: "iframe",
    url: `/apps/${app.id}`,
    source: app.dir,
    capabilities: app.capabilities,
    origin: app.origin ?? "local",
    marketplaceId: app.marketplaceId,
  };
}

export async function listInstalledApps(): Promise<InstalledApp[]> {
  return readAll();
}

/** Build an app's dist/ if it has an entry point but hasn't been built yet. */
async function ensureBuilt(app: InstalledApp): Promise<void> {
  if (!app.entry) return;
  const appDir = itemAppDir(app.id);
  if (!(await pathExists(path.join(appDir, "dist", "index.html")))) {
    await buildAppDir(appDir, app.entry, app.name);
  }
}

/** Manifests for the desktop — only currently-installed apps, discovered by
 *  listing the system/app/ symlinks (dangling links are skipped). */
export async function listInstalledManifests(): Promise<AppManifest[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(sysAppRoot());
  } catch {
    return [];
  }
  const apps = await Promise.all(entries.map(readApp));
  const installed = apps.filter((a): a is InstalledApp => a !== null && a.status === "installed");
  await Promise.allSettled(installed.map(ensureBuilt));
  return installed.sort((a, b) => a.createdAt - b.createdAt).map(toManifest);
}

/**
 * Install an app from a set of files (the assistant's buildApp / POST
 * /api/apps). The files become the `app/` facet of a NEW item under
 * user-apps/<id>/ — committed to that GitFS repo — and the item is installed
 * by symlinking dataDir()/system/app/<id> to it (served at /apps/<id>/).
 * `index.html` is required unless `entry` makes it a built project.
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
    /** Provenance (028): "marketplace" → opaque-origin sandbox. */
    origin?: "local" | "marketplace";
    marketplaceId?: string;
    /** Explicit item id (marketplace installs use the item's id); default slugified name. */
    id?: string;
  },
  opts?: { draft?: boolean },
): Promise<AppManifest> {
  if (!input.entry && !input.files["index.html"]) {
    throw new Error("Provide either an index.html (static app) or an entry (built project)");
  }
  const root = itemsRoot();
  await ensureRepo(root);
  // Draft install (under the Supervisor): check out the app-candidate branch
  // of the user-apps repo first, so this install lands on it (previewable)
  // instead of going live. The user then promotes or discards via the version
  // controls. Outside the Supervisor this is a no-op and the app installs live.
  if (opts?.draft && supervisorEnabled()) {
    await supervisorAppBegin();
  }
  const id = input.id ?? slugify(input.name);
  const appDir = itemAppDir(id);

  for (const [rel, content] of Object.entries(input.files)) {
    await writeFileAtomic(path.join(appDir, rel), content);
  }

  // Built project: bundle the source entry into dist/ (served instead of the raw files).
  if (input.entry) {
    await buildAppDir(appDir, input.entry, input.name);
  }

  const app: InstalledApp = {
    id,
    name: input.name,
    icon: input.icon || pickIcon(input.name),
    createdAt: Date.now(),
    dir: `/${id}/app`,
    status: "installed",
    entry: input.entry,
    capabilities: input.capabilities,
    origin: input.origin,
    marketplaceId: input.marketplaceId,
  };
  await writeManifest(app);
  await commitAll(root, `install app ${id}${opts?.draft ? " (draft)" : ""}`);
  await createAppSymlink(path.join(root, id), id);
  return toManifest(app);
}

/**
 * Install the app facet of an EXISTING item under user-apps/<id>/ (marketplace
 * installs — the item was already copied/committed there). Writes provenance
 * metadata into its app.json (created if the item didn't ship one) and creates
 * the system/app/<id> symlink.
 */
export async function installItemApp(
  id: string,
  meta?: { name?: string; icon?: string; origin?: "local" | "marketplace"; marketplaceId?: string },
): Promise<AppManifest> {
  const appDir = itemAppDir(id);
  if (!(await pathExists(path.join(appDir, "index.html"))) && !(await pathExists(path.join(appDir, "dist", "index.html")))) {
    throw new Error(`Item "${id}" has no app/index.html to install.`);
  }
  const existing = await readApp(id);
  const app: InstalledApp = {
    id,
    name: meta?.name ?? existing?.name ?? toDisplayName(id),
    icon: meta?.icon ?? existing?.icon ?? pickIcon(meta?.name ?? id),
    createdAt: existing?.createdAt || Date.now(),
    dir: `/${id}/app`,
    status: "installed",
    entry: existing?.entry,
    capabilities: existing?.capabilities,
    origin: meta?.origin === "marketplace" ? "marketplace" : existing?.origin,
    marketplaceId: meta?.marketplaceId ?? existing?.marketplaceId,
  };
  await writeManifest(app);
  await commitAll(itemsRoot(), `install app ${id}`);
  await createAppSymlink(path.join(itemsRoot(), id), id);
  return toManifest(app);
}

/** Soft uninstall: remove the system/app/<id> symlink so the app leaves the
 *  desktop; the item's files stay under user-apps/<id>/ for restore. */
export async function uninstallApp(id: string): Promise<InstalledApp[]> {
  await removeAppSymlink(id);
  return readAll();
}

/** Restore a previously uninstalled app (its item files were kept). */
export async function restoreApp(id: string): Promise<AppManifest | undefined> {
  const app = await readApp(id);
  if (!app) return undefined;
  await createAppSymlink(path.join(itemsRoot(), id), id);
  return toManifest({ ...app, status: "installed" });
}

/** Update the capability grants for an installed app. */
export async function setAppCapabilities(id: string, capabilities: AppCapability[]): Promise<AppManifest | undefined> {
  const app = await readApp(id);
  if (!app) return undefined;
  const updated: InstalledApp = { ...app, capabilities };
  await writeManifest(updated);
  await commitAll(itemsRoot(), `update capabilities for app ${id}`);
  return toManifest(updated);
}

/** Permanently delete the item's folder from user-apps/ and commit the
 *  removal. Refuses while the item's service is still installed — uninstall
 *  the service first (Settings → Plugins → Services). */
export async function purgeApp(id: string): Promise<InstalledApp[]> {
  if (await pathExists(path.join(dataDir(), "system", "services", id))) {
    throw new Error(`Item "${id}" still has an installed service — uninstall the service first.`);
  }
  await removeAppSymlink(id);
  await fs.rm(path.join(itemsRoot(), id), { recursive: true, force: true }).catch(() => {});
  await commitAll(itemsRoot(), `purge app ${id}`);
  return readAll();
}
