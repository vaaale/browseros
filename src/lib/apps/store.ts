import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { listInstalledItems, getInstalledItem, itemLinkPath, itemProvenanceKey, RESERVED_ITEM_IDS } from "@/system/items/installed";
import type { InstalledItem } from "@/system/items/installed";
import { resolveCapabilities, writeCapabilities } from "@/system/items/capabilities";
import { writeFileAtomic } from "@/os/atomic-write";
import { ensureRepo, commitAll } from "@/lib/gitfs/store";
import { buildAppDir } from "@/lib/apps/build";
import { branchDataRoot } from "@/lib/devharness/branch-data-root";
import { logger } from "@/lib/logging/server-logger";
import { createAppSymlink, removeAppSymlink } from "@/system/marketplace/install/symlinkManager";
import type { AppManifest, AppCapability, AppEventHandlerDeclaration } from "@/os/types";
import type { ServiceManifest } from "@/core/service/types";

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
  /**
   * URL override for plugin-served apps. When set, the app opens at this URL
   * instead of the default /apps/<id>/ path. Used by voiceEngine / integration
   * plugins that serve their app via /api/plugin/<id>/app.
   */
  appUrl?: string;
  /** 034-event-notification-system: UI event handlers declared in app.json. */
  eventHandlers?: AppEventHandlerDeclaration[];
  /** 034-event-notification-system: granted event-namespace prefixes. */
  eventNamespaces?: string[];
}

/** The ONE gitfs repo root for the user's local marketplace (034/035) — every
 *  writer must ensureRepo/commitAll HERE, never at itemsRoot(), or git init
 *  silently creates a second, disconnected repo nested inside the first. */
const userAppsDir = (root?: string) => path.join(root ?? dataDir(), "user-apps");
// Items live under user-apps/items/, the same shape as any marketplace clone
// (034 FR-001). This is also where Build Studio's new apps land (034 FR-009).
const itemsRoot = (root?: string) => path.join(userAppsDir(root), "items");
/** Installed items live as one symlink each under dataDir()/system/ (035). */
const sysAppRoot = () => path.join(dataDir(), "system");
/** Where an item the USER authors is written — inside their own marketplace. */
const authoredItemDir = (id: string, root?: string) => path.join(itemsRoot(root), id);
/** Where an item's app facet is written — inside their own marketplace. */
const authoredAppDir = (id: string, root?: string) => path.join(authoredItemDir(id, root), "app");
/**
 * Where an INSTALLED app is read from: through its item symlink, so a
 * marketplace-sourced app resolves into that marketplace's clone rather than
 * being expected under user-apps (035 FR-002).
 */
const itemAppDir = (id: string) => path.join(itemLinkPath(id), "app");
const linkPath = (id: string) => path.join(sysAppRoot(), id);

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `app-${Date.now().toString(36)}`;
}

/** An item id becomes a single path segment (`authoredItemDir`/`itemLinkPath`
 *  both `path.join` it directly) — `path.join` collapses `..` segments rather
 *  than jailing them, so an unvalidated id coming from outside BOS's own
 *  slugify() (an explicit `id` passed to `installItem()`, or to
 *  `createItemSpec()` in `@/lib/specs/create`, which re-checks it early for a
 *  clearer error) is an arbitrary-file-write vector, not just a cosmetic
 *  concern. Must be a single safe segment: never empty, never containing a
 *  path separator, never literally "." or "..". */
export function isSafeItemId(id: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(id) && id !== "." && id !== "..";
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

export async function readApp(id: string, knownItem?: InstalledItem | null): Promise<InstalledApp | null> {
  const item = knownItem ?? (await getInstalledItem(id));
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
    capabilities: await resolveCapabilities(id, Array.isArray(m.capabilities) ? (m.capabilities as AppCapability[]) : undefined),
    // Provenance is DERIVED from where the install symlink resolves (035 FR-009),
    // never read back from a file the marketplace controls.
    origin: item ? item.origin : (m.origin === "marketplace" ? "marketplace" : undefined),
    marketplaceId: item ? item.marketplaceId : (typeof m.marketplaceId === "string" ? m.marketplaceId : undefined),
    appUrl: typeof m.appUrl === "string" ? m.appUrl : undefined,
    eventHandlers: Array.isArray(m.eventHandlers) ? (m.eventHandlers as AppEventHandlerDeclaration[]) : undefined,
    eventNamespaces: Array.isArray(m.eventNamespaces) ? (m.eventNamespaces as string[]) : undefined,
  };
}

/**
 * The capabilities the item's own `app.json` DECLARES — what the app ASKS for,
 * as opposed to `readApp().capabilities`, which is what BOS has GRANTED
 * (`system/config/<id>/capabilities.json`).
 *
 * Needed by declaration-gated capabilities (040-assistant-broker-capability,
 * ADR-6): `assistant` is grantable only to an app whose manifest requests it, so
 * the grant route has to be able to read the request separately from the grant.
 * Returns [] for an item with no/malformed manifest.
 */
export async function readDeclaredCapabilities(id: string): Promise<AppCapability[]> {
  try {
    const raw = await fs.readFile(path.join(itemAppDir(id), MANIFEST), "utf8");
    const m = JSON.parse(raw) as { capabilities?: unknown };
    return Array.isArray(m.capabilities) ? (m.capabilities as AppCapability[]) : [];
  } catch {
    return [];
  }
}

/** Discover all app-carrying items by listing user-apps/. */
async function readAll(): Promise<InstalledApp[]> {
  // The ONE shared installed-item scan (035 FR-007): an item is an installed app
  // when it carries an app/ facet. Never scan user-apps here — "present in my
  // marketplace" and "installed" are different questions, and conflating them is
  // the misconception this whole change removes.
  const items = (await listInstalledItems()).filter((i) => i.facets.app && !i.broken);
  const apps = await Promise.all(items.map((i) => readApp(i.id, i)));
  return apps.filter((a): a is InstalledApp => a !== null).sort((a, b) => a.createdAt - b.createdAt);
}

async function writeManifest(app: InstalledApp, root?: string): Promise<void> {
  const { dir: _dir, status: _status, ...rest } = app;
  void _dir; void _status;
  // Only ever called for apps the user authored (see setAppCapabilities/installItem).
  await writeFileAtomic(path.join(authoredAppDir(app.id, root), MANIFEST), JSON.stringify(rest, null, 2));
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
    url: app.appUrl ?? `/apps/${app.id}`,
    source: app.dir,
    capabilities: app.capabilities,
    origin: app.origin ?? "local",
    marketplaceId: app.marketplaceId,
    eventHandlers: app.eventHandlers,
    eventNamespaces: app.eventNamespaces,
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

/** Manifests for the desktop — only currently-installed apps (broken item
 *  symlinks are skipped). */
export async function listInstalledManifests(): Promise<AppManifest[]> {
  const items = (await listInstalledItems()).filter((i) => i.facets.app && !i.broken);
  const apps = await Promise.all(items.map((i) => readApp(i.id, i)));
  const installed = apps.filter((a): a is InstalledApp => a !== null && a.status === "installed");
  await Promise.allSettled(installed.map(ensureBuilt));
  return installed.sort((a, b) => a.createdAt - b.createdAt).map(toManifest);
}

/** True when `files` (item-root-relative paths, e.g. "app/index.html",
 *  "services/service.json") contain at least one facet the shared installed-item
 *  scanner (`src/system/items/installed.ts`) recognizes, OR an app build `entry`
 *  is supplied (which produces an app facet). Mirrors `readFacets()` there. */
function filesHaveARecognizedFacet(files: Record<string, string>, entry?: string): boolean {
  if (entry) return true;
  const keys = Object.keys(files);
  return (
    !!files["app/index.html"] ||
    !!files["app/app.json"] ||
    !!files["services/service.json"] ||
    !!files["plugin/bos-plugin.json"] ||
    keys.some((k) => k.startsWith("hooks/")) ||
    keys.some((k) => k.startsWith("spec/"))
  );
}

export interface InstallItemResult {
  /** Manifest for the item's `app/` facet, if it has one. */
  app?: AppManifest;
  /** Manifest for the item's `services/` facet, if it has one — installed and
   *  auto-started the same way a Marketplace-triggered service install is,
   *  EXCEPT on a branch install, where it is validated only (`branch` set). */
  service?: ServiceManifest;
  /** Set when the item landed in a FEATURE BRANCH's data clone rather than in
   *  this process's own root. The item is then NOT installed here: there is no
   *  `system/<id>` symlink in this root, so `/apps/<id>/` cannot serve it and
   *  the desktop must not register or launch it. Callers surface "build the
   *  preview to run it" instead of opening a window that cannot load. */
  branch?: string;
}

/**
 * Install an ITEM from a set of files (the assistant's buildApp / POST
 * /api/apps, /api/apps/build). `files` keys are paths relative to the ITEM
 * ROOT — e.g. "app/index.html", "app/src/main.tsx", "services/service.json",
 * "services/index.js", "config/default.json" — mirroring the on-disk item
 * layout exactly (user-specs/002-service-daemons): an item may bundle any mix
 * of app/, services/, plugin/, hooks/, spec/, config/. The files become that
 * mix of facets under user-apps/<id>/ — committed to that GitFS repo — and the
 * item is installed by ONE symlink at dataDir()/system/<id> (035-install-by-
 * symlink), which the shared scanner then reads to discover every facet.
 *
 * At least one recognized facet (or a build `entry`, which implies an app
 * facet) is required — this is not app-only: a services-only item (a
 * background daemon with no UI) is a fully valid install.
 */
export async function installItem(
  input: {
    name: string;
    icon?: string;
    /** Item-root-relative paths — see the facet examples above. */
    files: Record<string, string>;
    /** Built project: source entry relative to the app facet (e.g. "src/main.tsx") esbuild bundles into app/dist/. Only meaningful when the item has an app facet. */
    entry?: string;
    /** BOS SDK capability grants for the app facet. Absent = no BOS SDK access. */
    capabilities?: AppCapability[];
    /** Provenance (028): "marketplace" → opaque-origin sandbox (app facet only). */
    origin?: "local" | "marketplace";
    marketplaceId?: string;
    /** Explicit item id (marketplace installs use the item's id); default slugified name. */
    id?: string;
  },
  opts?: {
    draft?: boolean;
    /** The active `bos/*` feature branch this install belongs to. On base its
     *  content is redirected into that branch's data clone, so the user can
     *  keep working in base and switch to the preview only to test. */
    branch?: string;
  },
): Promise<InstallItemResult> {
  if (!filesHaveARecognizedFacet(input.files, input.entry)) {
    throw new Error(
      "Provide at least one recognized facet: app/index.html (or entry, for a built app), services/service.json, plugin/bos-plugin.json, hooks/*, or spec/*.",
    );
  }
  // A draft install belongs to a feature branch. `user-apps` is branch-COUPLED
  // (020): the Supervisor mounts it as a worktree on that branch inside the
  // branch's data clone, and promotes/discards it with the branch's code and
  // specs. `dataRoot` resolves to that clone when this is base, and to this
  // process's own root inside a preview (already the branch's clone) or with no
  // Supervisor. So the user stays in BASE for the whole job and only switches
  // to the preview at the end, to test the built candidate.
  //
  // Every path below derives from `dataRoot` rather than dataDir() — item
  // content, the install symlink, seeded config and bundled assets alike — so
  // an install cannot half-land, with content on the branch and its symlink in
  // the live directory.
  const dataRoot = await branchDataRoot(opts?.draft ? opts.branch : undefined);
  const targetsBranch = dataRoot !== dataDir();
  // ensureRepo/commitAll must run at userAppsDir() — the repo root the
  // Supervisor couples to a feature branch — not at itemsRoot(), or the commit
  // lands in a repo that branch can never see (034/035).
  const root = userAppsDir(dataRoot);
  await ensureRepo(root);
  const id = input.id ?? slugify(input.name);
  if (!isSafeItemId(id)) {
    throw new Error(`Invalid item id "${id}": must contain only letters, digits, '.', '_', '-', and not be "." or "..".`);
  }
  // Write through the item's REAL location (user-apps/items/<id>/), never
  // through itemAppDir()/itemLinkPath() — those resolve via dataDir()/system/<id>,
  // which for a BRAND-NEW id doesn't exist yet. Writing there first creates a
  // real directory instead of following a (nonexistent) symlink, and the later
  // createAppSymlink() then fails trying to `rm` a non-empty real directory to
  // replace it — this was a real, live bug for any never-before-installed id.
  const itemDir = authoredItemDir(id, dataRoot);
  // Both checks below duplicate what createAppSymlink()/installItemLink() would
  // catch a few lines further down — deliberately, because by then the files
  // are already written and committed. Every caller (app_install, app_build,
  // createItemSpec, a marketplace install) goes through THIS function, so this
  // is the one place that can refuse BEFORE any write, instead of leaving an
  // orphaned, git-committed directory behind that a later failed symlink
  // creation can never clean up (purgeApp() itself refuses on a marketplace-
  // origin mismatch, so such an orphan was otherwise permanent).
  if (RESERVED_ITEM_IDS.has(id)) {
    throw new Error(`"${id}" is a reserved item id — dataDir()/system/${id}/ is used by BOS itself.`);
  }
  // A service facet's id MUST equal the item id. Checked HERE, from the input
  // map, before anything is written or committed — it used to be checked only
  // after `commitAll`, so a mismatch left a committed, promotable item
  // directory behind with no symlink and no registered service. That orphan is
  // exactly what this preflight exists to prevent, and it happened for real:
  // staged content authored for item `workflows` was installed under the id
  // `workflow-manager`, the commit landed and was promoted, and the install
  // then failed on the id mismatch — leaving a second marketplace entry that
  // could never be installed. The rest of the manifest (schema, entry file)
  // still validates later, since that needs the files on disk.
  const serviceJson = input.files["services/service.json"];
  if (serviceJson) {
    let declaredId: unknown;
    try {
      declaredId = (JSON.parse(serviceJson) as { id?: unknown }).id;
    } catch (err) {
      throw new Error(`services/service.json is not valid JSON: ${(err as Error).message}`);
    }
    if (declaredId !== id) {
      throw new Error(
        `service.json id "${String(declaredId)}" does not match item id "${id}". ` +
          `A service facet is installed under its item's id — either install this content under id "${String(declaredId)}", ` +
          `or change services/service.json's id to "${id}" (which also changes the service's config and the id its app calls).`,
      );
    }
  }
  const existing = await getInstalledItem(id, dataRoot);
  if (existing) {
    // Compared by PROVENANCE, not absolute path: a branch install targets the
    // branch clone, whose inherited system/<id> symlink still points into base,
    // so an absolute comparison rejected every update to an already-installed
    // item (see itemProvenanceKey).
    const roots = [dataRoot, dataDir()];
    if (itemProvenanceKey(existing.itemPath, roots) !== itemProvenanceKey(itemDir, roots)) {
      throw new Error(`"${id}" is already installed from a different source (${existing.itemPath}). Uninstall it first if you want to install this one instead.`);
    }
  }

  for (const [rel, content] of Object.entries(input.files)) {
    await writeFileAtomic(path.join(itemDir, rel), content);
  }

  const hasApp = !!input.files["app/index.html"] || !!input.files["app/app.json"] || !!input.entry;
  const hasService = !!input.files["services/service.json"];

  // Built project: bundle the source entry into app/dist/ (served instead of the raw files).
  if (input.entry) {
    await buildAppDir(path.join(itemDir, "app"), input.entry, input.name);
  }

  let app: InstalledApp | undefined;
  if (hasApp) {
    app = {
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
    await writeManifest(app, dataRoot);
  }

  await commitAll(root, `install item ${id}${opts?.draft ? " (draft)" : ""}`);
  await createAppSymlink(itemDir, id, dataRoot);

  let service: ServiceManifest | undefined;
  if (hasService) {
    // Reuses the exact same validate/register/auto-start flow a Marketplace
    // service install goes through. installItemLink() inside is idempotent, so
    // re-symlinking here (already done via createAppSymlink above) is harmless.
    if (targetsBranch) {
      // Validate the manifest so a broken service still fails the install
      // immediately, but do NOT register or start it in THIS process: the
      // content belongs to a feature branch, and it is that branch's PREVIEW
      // that must run it. The preview's own boot does exactly that
      // (instrumentation.ts's startAll over its own data root), so registering
      // it here would run a preview's service inside base, against a registry
      // and ports that base is live-serving from.
      const { readServiceManifest, validateManifest } = await import("@/core/service/manifestValidator");
      const servicesDir = path.join(itemDir, "services");
      const manifest = await readServiceManifest(servicesDir);
      if (manifest.id !== id) {
        throw new Error(`service.json id "${manifest.id}" does not match item id "${id}"`);
      }
      const result = await validateManifest(manifest, servicesDir);
      if (!result.valid) {
        throw new Error(`Invalid service manifest for "${id}": ${result.errors.join("; ")}`);
      }
      service = manifest;
      logger().info("apps.store", "service validated but not started: belongs to a feature branch, its preview will start it", { id, branch: opts?.branch });
    } else {
      const { installService } = await import("@/system/marketplace/install/serviceInstaller");
      service = await installService(itemDir, id);
    }
  }

  return { app: app ? toManifest(app) : undefined, service, ...(targetsBranch ? { branch: opts?.branch } : {}) };
}

/**
 * Register the app facet of an ALREADY-INSTALLED item and return its manifest.
 *
 * Writes nothing and creates no symlink (035 FR-001/FR-009): the caller has
 * already linked the item at `dataDir()/system/<id>`, wherever it actually lives,
 * and `app.json` belongs to whoever authored the item. Provenance is derived from
 * the link, so there is nothing for BOS to persist.
 *
 * An earlier revision wrote `app.json` into `user-apps/items/<id>/app/` and
 * linked THERE — which both created content in the user's own marketplace for
 * someone else's app, and collided with the correct link pointing at the
 * marketplace clone.
 */
export async function installItemApp(
  id: string,
  meta?: { name?: string; icon?: string; origin?: "local" | "marketplace"; marketplaceId?: string; appUrl?: string },
): Promise<AppManifest> {
  const isPluginServed = !!meta?.appUrl;
  if (!isPluginServed) {
    const appDir = itemAppDir(id);
    if (!(await pathExists(path.join(appDir, "index.html"))) && !(await pathExists(path.join(appDir, "dist", "index.html")))) {
      throw new Error(`Item "${id}" has no app/index.html to install.`);
    }
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
    appUrl: meta?.appUrl ?? existing?.appUrl,
  };
  // No write, no symlink — see the note above.
  return toManifest(app);
}

/**
 * Uninstall: the app is gone. Removes the item's install symlink, so it leaves
 * the desktop AND the registry — there is no "uninstalled but still listed"
 * state under 035, because installed state IS the symlink. Reinstalling is a
 * Marketplace action.
 *
 * If the item also has a service installed, cascade to uninstallService() first
 * so a stranded worker doesn't outlive the entry. Cascade failures are logged,
 * not raised: removing the entry must always succeed.
 */
export async function uninstallApp(id: string): Promise<InstalledApp[]> {
  if ((await getInstalledItem(id))?.facets.service) {
    const { uninstallService } = await import("@/system/marketplace/install/serviceInstaller");
    await uninstallService(id).catch((err) => {
      console.error(`[apps.store] cascade uninstallService(${id}) failed:`, err);
    });
  }
  await removeAppSymlink(id);
  return readAll();
}

/**
 * Update the capability grants for an installed app.
 *
 * Grants are BOS-owned state at `system/config/<id>/capabilities.json` (035),
 * never the item's `app.json`. A grant is something BOS gives, not something an
 * item claims — and for a marketplace item `app.json` sits in a read-only clone
 * where a grant could silently widen itself on the next `git pull`. Storing them
 * BOS-side also means this works identically for marketplace and authored apps.
 */
export async function setAppCapabilities(id: string, capabilities: AppCapability[]): Promise<AppManifest | undefined> {
  const app = await readApp(id);
  if (!app) return undefined;
  await writeCapabilities(id, capabilities);
  return toManifest({ ...app, capabilities });
}

/**
 * Permanently delete the item's content. Only meaningful for items the user
 * OWNS — i.e. whose install resolves into user-apps/items/ (035 FR-013). For a
 * marketplace item there is nothing to purge: its content belongs to the
 * marketplace, and removing that marketplace is the equivalent operation.
 */
export async function purgeApp(id: string): Promise<InstalledApp[]> {
  const item = await getInstalledItem(id);
  if (item?.facets.service) {
    throw new Error(`Item "${id}" still has an installed service — uninstall the service first.`);
  }
  if (item && item.origin !== "local") {
    throw new Error(
      `"${id}" comes from marketplace "${item.marketplaceId ?? "unknown"}" — there is nothing to purge. ` +
      `Uninstall it, or remove the marketplace.`,
    );
  }
  await removeAppSymlink(id);
  await fs.rm(path.join(itemsRoot(), id), { recursive: true, force: true }).catch(() => {});
  await commitAll(userAppsDir(), `purge app ${id}`);
  return readAll();
}
