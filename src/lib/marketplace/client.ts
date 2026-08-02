import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir } from "@/os/data-dir";
import { itemLinkPath, getInstalledItem } from "@/system/items/installed";
import { writeFileAtomic } from "@/os/atomic-write";
import { commitAll } from "@/lib/gitfs/store";
import { userSpecRoot } from "@/lib/specs/spec-mount";
import { installItemApp } from "@/lib/apps/store";
import { logger } from "@/lib/logging/server-logger";
import { saveSkill, type SkillAsset } from "@/lib/agent/skills/store";
import { installService } from "@/system/marketplace/install/serviceInstaller";
import type { AppManifest } from "@/os/types";
import {
  validateManifest,
  validateMarketplaceUrl,
  type MarketplaceManifest,
  type MarketplaceItem,
  type MarketplaceItemApp,
  type MarketplaceItemSpec,
  type RegisteredMarketplace,
} from "./schema";

// Marketplace client (028): register remote git repos, sync them, and either
// ADOPT a spec (fork into the user spec store) or install/run an app. Untrusted
// input — every git URL is allowlisted and every marketplace.json validated
// before use, and git runs via execFile (no shell) so a hostile URL can't inject
// a command.

const exec = promisify(execFile);
const COMPONENT = "marketplace";

// dataDir()/user-apps/ (user-specs/002-service-daemons's "local marketplace")
// is exposed as an always-present, auto-scanned marketplace under this
// reserved id — same manifest shape, same install ops, no git clone involved.
// cloneDir()/readManifest() special-case it below; every install* function
// downstream (adoptSpec/installSkill/installMarketplaceItem)
// works against it unmodified because they only ever go through those two.
export const LOCAL_MARKETPLACE_ID = "user-apps";

const clonesDir = () => path.join(dataDir(), "marketplace");
const configFile = () => path.join(dataDir(), "config", "marketplaces.json");
const userAppsDir = () => path.join(dataDir(), "user-apps");
/** Items live under items/ — identical to any marketplace clone (034 FR-001). */
const userAppsItemsDir = () => path.join(userAppsDir(), "items");
const cloneDir = (id: string) => (id === LOCAL_MARKETPLACE_ID ? userAppsDir() : path.join(clonesDir(), id));
const MANIFEST = "marketplace.json";

// Claude plugin format constants (US-6).
const CLAUDE_SKILLS_INDEX = "skills_index.json";
const CLAUDE_PLUGIN_JSON = path.join(".claude-plugin", "plugin.json");
// Anthropic agent-skills format: .claude-plugin/marketplace.json with plugins[].skills[] paths.
const ANTHROPIC_MARKETPLACE_JSON = path.join(".claude-plugin", "marketplace.json");

function toDisplayName(slug: string): string {
  return slug.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

async function isClaudePlugin(dir: string): Promise<boolean> {
  return pathExists(path.join(dir, CLAUDE_SKILLS_INDEX));
}

async function isAnthropicPlugin(dir: string): Promise<boolean> {
  return pathExists(path.join(dir, ANTHROPIC_MARKETPLACE_JSON));
}

/** Extract a single-line field value from YAML frontmatter (--- ... ---). */
function extractFrontmatter(content: string, field: string): string | undefined {
  const fm = content.match(/^---\n([\s\S]*?)\n---/)?.[1];
  if (!fm) return undefined;
  return fm.match(new RegExp(`^${field}:\\s*(.+)$`, "m"))?.[1]?.trim();
}

/** Read the Claude skills_index.json + plugin.json and write a synthesized marketplace.json. */
async function convertClaudePlugin(dir: string): Promise<MarketplaceManifest> {
  const indexRaw = await fs.readFile(path.join(dir, CLAUDE_SKILLS_INDEX), "utf8");
  const indexParsed = JSON.parse(indexRaw) as Record<string, unknown>;
  // skills_index.json is { version, generated, skills: [...] }, not a bare array.
  const index = (Array.isArray(indexParsed.skills) ? indexParsed.skills : Array.isArray(indexParsed) ? indexParsed : []) as Array<Record<string, unknown>>;

  let pluginMeta: Record<string, unknown> = {};
  try {
    pluginMeta = JSON.parse(await fs.readFile(path.join(dir, CLAUDE_PLUGIN_JSON), "utf8")) as Record<string, unknown>;
  } catch {
    // optional — continue without it
  }

  const rawId = typeof pluginMeta.name === "string" ? pluginMeta.name : "claude-plugin";
  const id = rawId.replace(/[^a-zA-Z0-9._-]/g, "-");
  const name = toDisplayName(rawId);
  const version = typeof pluginMeta.version === "string" ? pluginMeta.version : "0.0.0";

  const items: MarketplaceManifest["items"] = index
    .filter((entry) => typeof entry.name === "string")
    .map((entry) => {
      const skillName = entry.name as string;
      return {
        id: skillName,
        name: toDisplayName(skillName),
        description: typeof entry.description === "string" ? entry.description : "",
        tags: Array.isArray(entry.tags)
          ? (entry.tags as unknown[]).filter((t): t is string => typeof t === "string")
          : undefined,
        skill: {
          path: `skills/${skillName}`,
          version: typeof entry.version === "string" ? entry.version : "0.0.0",
        },
      };
    });

  const manifest: MarketplaceManifest = { id, name, version, items };
  await fs.writeFile(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2));
  logger().debug(COMPONENT, "synthesized marketplace.json from Claude plugin", { id, skills: items.length });
  return manifest;
}

/**
 * Anthropic agent-skills format: .claude-plugin/marketplace.json with
 * { name, metadata: { version }, plugins: [{ skills: ["./skills/name", ...] }] }.
 * Flattens all plugin skill paths, reads each SKILL.md for its description,
 * and writes a synthesized marketplace.json.
 */
async function convertAnthropicPlugin(dir: string): Promise<MarketplaceManifest> {
  const raw = await fs.readFile(path.join(dir, ANTHROPIC_MARKETPLACE_JSON), "utf8");
  const meta = JSON.parse(raw) as Record<string, unknown>;

  const rawId = typeof meta.name === "string" ? meta.name : "anthropic-skills";
  const id = rawId.replace(/[^a-zA-Z0-9._-]/g, "-");
  const name = toDisplayName(rawId);
  const metaObj = meta.metadata && typeof meta.metadata === "object" ? meta.metadata as Record<string, unknown> : {};
  const version = typeof metaObj.version === "string" ? metaObj.version : "0.0.0";

  // Flatten skill paths from all plugins, dedup by id.
  const seen = new Set<string>();
  const skillPaths: Array<{ id: string; relPath: string }> = [];
  const plugins = Array.isArray(meta.plugins) ? (meta.plugins as Array<Record<string, unknown>>) : [];
  for (const plugin of plugins) {
    const skills = Array.isArray(plugin.skills) ? (plugin.skills as unknown[]) : [];
    for (const ref of skills) {
      if (typeof ref !== "string") continue;
      const relPath = ref.replace(/^\.\//, ""); // "./skills/foo" → "skills/foo"
      const skillId = path.basename(relPath);
      if (!seen.has(skillId)) {
        seen.add(skillId);
        skillPaths.push({ id: skillId, relPath });
      }
    }
  }

  const items: MarketplaceManifest["items"] = await Promise.all(
    skillPaths.map(async ({ id: skillId, relPath }) => {
      let description = "";
      try {
        const skillMd = await fs.readFile(path.join(dir, relPath, "SKILL.md"), "utf8");
        description = extractFrontmatter(skillMd, "description") ?? "";
      } catch { /* leave empty */ }
      return {
        id: skillId,
        name: toDisplayName(skillId),
        description,
        skill: { path: relPath, version },
      };
    }),
  );

  const manifest: MarketplaceManifest = { id, name, version, items };
  await fs.writeFile(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2));
  logger().debug(COMPONENT, "synthesized marketplace.json from Anthropic skills plugin", { id, skills: items.length });
  return manifest;
}

/**
 * Recursively walk a skill folder and collect assets into scripts[] and references[].
 * SKILL.md at the root is excluded (handled separately as content).
 * Files under scripts/ go into scripts; everything else into references.
 */
async function walkSkillDir(
  skillDir: string,
  scripts: SkillAsset[],
  references: SkillAsset[],
): Promise<void> {
  async function walk(dir: string, relBase: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryName = entry.name.toString();
      const relPath = relBase ? `${relBase}/${entryName}` : entryName;
      const fullPath = path.join(dir, entryName);
      if (entry.isDirectory()) {
        await walk(fullPath, relPath);
      } else if (entry.isFile()) {
        if (!relBase && entryName === "SKILL.md") continue; // handled as content
        try {
          const content = await fs.readFile(fullPath, "utf8");
          const asset: SkillAsset = { name: relPath, content };
          if (relPath.startsWith("scripts/")) {
            scripts.push(asset);
          } else {
            references.push(asset);
          }
        } catch {
          // skip binary / unreadable files
        }
      }
    }
  }
  await walk(skillDir, "");
}

async function git(args: string[], cwd?: string): Promise<void> {
  await exec("git", args, { cwd, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
}

async function pathExists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}

async function readConfig(): Promise<RegisteredMarketplace[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(configFile(), "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as RegisteredMarketplace[]) : [];
  } catch {
    return [];
  }
}

async function writeConfig(list: RegisteredMarketplace[]): Promise<void> {
  await writeFileAtomic(configFile(), JSON.stringify(list, null, 2));
}

/**
 * Scan dataDir()/user-apps/items/ and infer an item entry per directory — a
 * `services/service.json` makes it a `services` entry, an `app/index.html` an
 * `app` entry (the same item can be both, e.g. the Terminal reference item), a
 * non-empty `spec/` a `spec` entry. This preserves auto-discovery: dropping a
 * folder into items/ makes it installable without editing the manifest.
 *
 * Inference is INTENTIONALLY limited to what disk can tell us. Curated fields
 * (tags, icons, hand-written descriptions, non-standard entrypoints like
 * `items/x/app/dist`, and plugin facets such as voiceEngine) exist only in the
 * manifest and MUST survive — see reconcileLocalManifest (034 FR-003).
 */
/** Read a JSON file, returning null instead of throwing — used while scanning,
 *  where a missing or half-written file must not abort the whole catalog. */
async function readJsonSafe(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function scanLocalItems(): Promise<MarketplaceItem[]> {
  const root = userAppsItemsDir();
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[]);
  const items: MarketplaceItem[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const itemDir = path.join(root, id);

    let name = toDisplayName(id);
    let description = "";
    let version = "0.0.0";

    let services: MarketplaceItem["services"];
    const serviceManifestPath = path.join(itemDir, "services", "service.json");
    if (await pathExists(serviceManifestPath)) {
      try {
        const raw = JSON.parse(await fs.readFile(serviceManifestPath, "utf8")) as Record<string, unknown>;
        if (typeof raw.name === "string" && raw.name.trim()) name = raw.name;
        if (typeof raw.description === "string") description = raw.description;
        if (typeof raw.version === "string") version = raw.version;
        services = { entrypoint: path.posix.join("items", id), version };
      } catch {
        // Malformed service.json — skip the services entry, still consider app/spec below.
      }
    }

    // Local items install with origin "local" (same-origin iframe), so an
    // app/ facet is always exposable — no opaque-origin caveats apply here.
    //
    // Two shapes count as an app. `app/index.html` is a plain iframe app. But an
    // `app/app.json` with no index.html is a PLUGIN-SERVED app: BOS registered
    // the app and it is served from /api/plugin/<id>/app, so the item directory
    // legitimately holds only the manifest. Keying on index.html alone made such
    // an item invisible in its own marketplace even while installed and running.
    let app: MarketplaceItemApp | undefined;
    const appManifest = await readJsonSafe(path.join(itemDir, "app", "app.json"));
    const hasIndexHtml = await pathExists(path.join(itemDir, "app", "index.html"));
    if (appManifest || hasIndexHtml) {
      const icon = typeof appManifest?.icon === "string" ? appManifest.icon : undefined;
      if (typeof appManifest?.name === "string" && appManifest.name.trim()) name = appManifest.name;
      app = {
        entrypoint: `items/${id}/app`,
        // An appUrl in the manifest means the app is served by a plugin, not from
        // files under app/.
        runtime: typeof appManifest?.appUrl === "string" ? "plugin-served" : "iframe",
        version,
        ...(icon ? { icon } : {}),
      };
    }

    let spec: MarketplaceItemSpec | undefined;
    const specDir = path.join(itemDir, "spec");
    if ((await fs.readdir(specDir).catch(() => [])).length > 0) {
      spec = { path: `items/${id}/spec`, version };
    }

    // A plugin/ facet makes an item real even with nothing else in it (an engine
    // or integration with no UI of its own). The scan does NOT decide which KIND
    // of plugin it is — voiceEngine vs integration vs serverPlugin is a curated
    // claim in the manifest, not something to infer from a directory. Recognising
    // the shape is enough to keep such an item from being pruned as unrecognised.
    const hasPlugin = await pathExists(path.join(itemDir, "plugin", "bos-plugin.json"));

    if (!services && !app && !spec && !hasPlugin) continue; // not a recognised item shape

    items.push({ id, name, description, app, spec, services });
  }

  return items;
}

/**
 * The username of the requesting user, for naming a brand-new user-apps
 * marketplace (034 FR-006). The bastion injects `x-bos-username` on every
 * proxied request, so this is only available inside a request scope —
 * deliberately, which is why naming happens on first catalog read rather than at
 * boot. Outside a request (or standalone, with no bastion) it returns null.
 */
async function requestUsername(): Promise<string | null> {
  try {
    const { headers } = await import("next/headers");
    return (await headers()).get("x-bos-username");
  } catch {
    return null;
  }
}

/** Name for a not-yet-initialised user-apps marketplace: `<username>-marketplace`. */
async function defaultLocalMarketplaceName(): Promise<string> {
  const fromRequest = await requestUsername();
  if (fromRequest && /^[a-z0-9_-]+$/i.test(fromRequest)) return `${fromRequest.toLowerCase()}-marketplace`;
  // Standalone BOS has no bastion user; the OS account is the best available name.
  try {
    const os = await import("node:os");
    const local = os.userInfo().username;
    if (local && /^[a-z0-9_-]+$/i.test(local) && local !== "user") return `${local.toLowerCase()}-marketplace`;
  } catch { /* userInfo can throw in exotic environments */ }
  return "my-marketplace";
}

/**
 * Reconcile dataDir()/user-apps/marketplace.json against items/ and return it.
 *
 * MERGE, never regenerate (034 FR-003). A scan cannot reproduce curated
 * metadata — tags, icons, hand-written descriptions, non-standard entrypoints
 * (`items/lunar-lander/app/dist`), or plugin facets (`runtime: "plugin-served"`,
 * `voiceEngine.engineId`). Regenerating would strip a curated marketplace to a
 * skeleton and commit that, which is exactly what must not happen when the user
 * points user-apps at a real published marketplace.
 *
 * Writes + commits ONLY when something actually changed, so reading the catalog
 * never dirties a repo the user may be tracking against a remote (034 FR-004).
 */
async function reconcileLocalManifest(): Promise<MarketplaceManifest> {
  const root = userAppsDir();
  const manifestPath = path.join(root, MANIFEST);

  let existing: MarketplaceManifest | null = null;
  let raw: string | null = null;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch {
    raw = null;
  }
  if (raw !== null) {
    // A malformed manifest is the user's curated content — surface it, never
    // silently overwrite it.
    try {
      existing = validateManifest(JSON.parse(raw));
    } catch (err) {
      throw new Error(
        `${manifestPath} is not a valid marketplace manifest: ${(err as Error).message}. ` +
        `Fix or delete the file — BOS will not overwrite it.`,
      );
    }
  }

  const scanned = await scanLocalItems();
  const scannedById = new Map(scanned.map((i) => [i.id, i]));

  // Repair entrypoints left behind by the pre-034 flat layout. A manifest
  // written before items/ existed declares `terminal/app`; the directory now
  // lives at `items/terminal/app`, so the declared path resolves to nothing and
  // installing from the local marketplace fails. Rewriting it is completing the
  // move (the same job as re-pointing the installed-state symlinks), not
  // overriding curation — it only ever fires when the declared path is absent
  // AND the items/-prefixed one exists.
  const repairPath = async (rel: string): Promise<string> => {
    if (rel.startsWith("items/")) return rel;
    if (await pathExists(path.join(root, rel))) return rel;
    const prefixed = path.posix.join("items", rel);
    return (await pathExists(path.join(root, prefixed))) ? prefixed : rel;
  };
  // A facet whose files are gone is a false advertisement: the catalog offers an
  // app (or spec, or service) that cannot be installed. Dropping it is the same
  // judgement as pruning an item whose directory is gone — the manifest describes
  // what is in the repo, and a declaration is not curation once it stops being
  // true. Only ever fires when the declared path is absent AFTER repair, so a
  // non-standard-but-real entrypoint is untouched.
  const gone = async (rel: string): Promise<boolean> => !(await pathExists(path.join(root, rel)));

  const repairItem = async (item: MarketplaceItem): Promise<MarketplaceItem> => {
    const next: MarketplaceItem = { ...item };
    if (next.app) {
      // Every app facet has an app/ directory: files for an iframe app, or just
      // app.json for a plugin-served one (that manifest is what makes it an app).
      const entrypoint = await repairPath(next.app.entrypoint);
      if (await gone(entrypoint)) delete next.app; else next.app = { ...next.app, entrypoint };
    }
    if (next.spec) {
      const p = await repairPath(next.spec.path);
      if (await gone(p)) delete next.spec; else next.spec = { ...next.spec, path: p };
    }
    if (next.services) {
      const entrypoint = await repairPath(next.services.entrypoint);
      if (await gone(entrypoint)) delete next.services; else next.services = { ...next.services, entrypoint };
    }
    if (next.serverPlugin) {
      const entrypoint = await repairPath(next.serverPlugin.entrypoint);
      if (await gone(entrypoint)) delete next.serverPlugin; else next.serverPlugin = { ...next.serverPlugin, entrypoint };
    }
    if (next.voiceEngine) {
      const entrypoint = await repairPath(next.voiceEngine.entrypoint);
      if (await gone(entrypoint)) delete next.voiceEngine; else next.voiceEngine = { ...next.voiceEngine, entrypoint };
    }
    return next;
  };

  const base: MarketplaceManifest = existing ?? {
    id: await defaultLocalMarketplaceName(),
    name: await defaultLocalMarketplaceName(),
    version: "1.0.0",
    description: "My own apps, services and plugins.",
    items: [],
  };

  // Keep declared entries in their existing order, untouched, dropping only
  // those whose directory is gone. Then append newly discovered items.
  const surviving = base.items.filter((item) => scannedById.has(item.id));
  const pruned = base.items.length - surviving.length;
  const kept = await Promise.all(surviving.map(repairItem));
  const known = new Set(kept.map((i) => i.id));
  const added = scanned.filter((i) => !known.has(i.id));

  const merged: MarketplaceManifest = { ...base, items: [...kept, ...added] };

  // "Changed" is decided by comparing the SERIALIZED result to what is on disk.
  // Anything else over-reports: an earlier version compared inferred facet
  // shapes and committed a manifest whose only difference was a trailing
  // newline. Reading a catalog must leave a clean working tree (034 FR-004).
  const serialized = JSON.stringify(merged, null, 2) + "\n";
  const changed = raw === null || serialized !== raw;

  if (changed) {
    await fs.mkdir(root, { recursive: true });
    await writeFileAtomic(manifestPath, serialized);
    const parts = [
      added.length ? `${added.length} added` : "",
      pruned ? `${pruned} removed` : "",
    ].filter(Boolean);
    const summary = existing === null
      ? "initialise marketplace manifest"
      : parts.length
        ? `sync marketplace manifest (${parts.join(", ")})`
        : "repair marketplace manifest";
    await commitAll(root, summary).catch(() => undefined);
    logger().info(COMPONENT, "local manifest reconciled", { added: added.length, pruned, created: existing === null });
  }

  return merged;
}

async function readManifest(id: string): Promise<MarketplaceManifest> {
  // user-apps is a real marketplace repo with a real on-disk manifest (034
  // FR-002); it is reconciled against items/ first so hand-created folders are
  // picked up, then read like any other.
  if (id === LOCAL_MARKETPLACE_ID) return reconcileLocalManifest();
  const raw = await fs.readFile(path.join(cloneDir(id), MANIFEST), "utf8");
  return validateManifest(JSON.parse(raw));
}

/** Register a marketplace: allowlist the URL, clone, validate the manifest, keep. */
export async function addMarketplace(url: string): Promise<RegisteredMarketplace> {
  const allowLocal = process.env.NODE_ENV !== "production";
  const safeUrl = validateMarketplaceUrl(url, { allowLocal });

  await fs.mkdir(clonesDir(), { recursive: true });
  const tmp = path.join(clonesDir(), `.tmp-${Date.now()}`);
  await fs.rm(tmp, { recursive: true, force: true });
  logger().debug(COMPONENT, "cloning marketplace", { url: safeUrl });
  try {
    await git(["clone", "--depth", "1", safeUrl, tmp]);

    // Prefer a native marketplace.json; fall back to Claude plugin format (US-6).
    let manifest: MarketplaceManifest;
    if (await pathExists(path.join(tmp, MANIFEST))) {
      manifest = validateManifest(JSON.parse(await fs.readFile(path.join(tmp, MANIFEST), "utf8")));
    } else if (await isClaudePlugin(tmp)) {
      manifest = await convertClaudePlugin(tmp);
    } else if (await isAnthropicPlugin(tmp)) {
      manifest = await convertAnthropicPlugin(tmp);
    } else {
      throw new Error(
        "Repository has no marketplace.json, no skills_index.json, and no .claude-plugin/marketplace.json. " +
        "Not a recognised BOS or Claude plugin marketplace.",
      );
    }

    // "user-apps" stays reserved as the internal key for the local slot — a
    // remote claiming it would alias onto dataDir()/user-apps via cloneDir().
    if (manifest.id === LOCAL_MARKETPLACE_ID) {
      throw new Error(`"${LOCAL_MARKETPLACE_ID}" is a reserved marketplace id — rename the marketplace in its manifest.`);
    }
    // Your own user-apps repo IS a marketplace, so adding it (or any repo whose
    // manifest id matches it) as a remote would register the same marketplace
    // twice (034 FR-007).
    const localId = await pathExists(userAppsDir())
      ? await readManifest(LOCAL_MARKETPLACE_ID).then((m) => m.id).catch(() => null)
      : null;
    if (localId && manifest.id === localId) {
      throw new Error(
        `"${manifest.id}" is already your own local marketplace (dataDir()/user-apps/) — ` +
        `there is no need to add it as a remote.`,
      );
    }
    if ((await readConfig()).some((m) => m.id === manifest.id) || (await pathExists(cloneDir(manifest.id)))) {
      throw new Error(`Marketplace "${manifest.id}" is already registered.`);
    }
    await fs.rename(tmp, cloneDir(manifest.id));
    const entry: RegisteredMarketplace = {
      id: manifest.id,
      url: safeUrl,
      name: manifest.name,
      addedAt: new Date().toISOString(),
      lastSynced: new Date().toISOString(),
    };
    await writeConfig([...(await readConfig()), entry]);
    logger().info(COMPONENT, "marketplace registered", { id: manifest.id, items: manifest.items.length });
    return entry;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/** Unregister a marketplace and delete its clone. Adopted specs are unaffected
 *  (adoption is a fork) — this only removes the read-only source + its apps. */
export async function removeMarketplace(id: string): Promise<void> {
  if (id === LOCAL_MARKETPLACE_ID) {
    throw new Error(`"${LOCAL_MARKETPLACE_ID}" mirrors your local user-apps/ folder, not a registered marketplace — there's nothing to remove.`);
  }

  // Installed items are symlinks INTO this clone (035), so removing it would
  // leave them all dangling. Refuse and name them — silently uninstalling
  // someone's apps is far too much collateral for one click (035 FR-012).
  const { itemsFromMarketplace } = await import("@/system/items/installed");
  const installed = await itemsFromMarketplace(id);
  if (installed.length > 0) {
    const names = installed.map((i) => i.id).sort().join(", ");
    throw new Error(
      `Cannot remove marketplace "${id}": ${installed.length} installed item(s) come from it (${names}). ` +
      `Uninstall them first.`,
    );
  }

  await writeConfig((await readConfig()).filter((m) => m.id !== id));
  await fs.rm(cloneDir(id), { recursive: true, force: true }).catch(() => {});
  logger().info(COMPONENT, "marketplace removed", { id });
}

/** Pull the latest for a registered marketplace. Installed items are symlinks
 *  into the clone, so a sync updates every item installed from it with no
 *  reinstall (035 SC-002). Nothing to do for the local user-apps/ marketplace —
 *  BOS doesn't manage that repo's git remote; the user does, as with user-specs/. */
export async function syncMarketplace(id: string): Promise<void> {
  if (id === LOCAL_MARKETPLACE_ID) return;
  if (!(await pathExists(cloneDir(id)))) throw new Error(`Marketplace "${id}" is not registered.`);
  await git(["pull", "--ff-only"], cloneDir(id));
  // Regenerate the synthesized marketplace.json for converted plugin repos (US-6).
  const d = cloneDir(id);
  if (await isClaudePlugin(d)) {
    await convertClaudePlugin(d);
  } else if (await isAnthropicPlugin(d)) {
    await convertAnthropicPlugin(d);
  }
  const list = await readConfig();
  const entry = list.find((m) => m.id === id);
  if (entry) {
    entry.lastSynced = new Date().toISOString();
    await writeConfig(list);
  }
}

export async function listRegistered(): Promise<RegisteredMarketplace[]> {
  return readConfig();
}

export interface MarketplaceCatalogEntry extends RegisteredMarketplace {
  items: MarketplaceItem[];
  error?: string;
}

/** All registered marketplaces with their (validated) items — for the app UI.
 *  Prepends the always-present local user-apps/ "marketplace" (not stored in
 *  marketplaces.json — it exists whenever dataDir()/user-apps/ does). */
export async function listCatalog(): Promise<MarketplaceCatalogEntry[]> {
  const registered = await readConfig();
  const entries = await Promise.all(
    registered.map(async (m) => {
      try {
        return { ...m, items: (await readManifest(m.id)).items };
      } catch (err) {
        return { ...m, items: [], error: (err as Error).message };
      }
    }),
  );

  if (await pathExists(userAppsDir())) {
    // The slot is keyed by LOCATION (LOCAL_MARKETPLACE_ID); the displayed
    // identity comes from the repo's own manifest, so a user-apps pointed at a
    // published marketplace shows that marketplace's name (034 FR-007).
    const local: RegisteredMarketplace = {
      id: LOCAL_MARKETPLACE_ID,
      url: "(local) dataDir()/user-apps/",
      name: "My Apps",
      addedAt: "",
      lastSynced: null,
    };
    try {
      const manifest = await readManifest(LOCAL_MARKETPLACE_ID);
      entries.unshift({ ...local, name: manifest.name || local.name, items: manifest.items });
    } catch (err) {
      entries.unshift({ ...local, items: [], error: (err as Error).message });
    }
  }

  return entries;
}

/**
 * The ITEM directory to symlink for an install (035). Facet entrypoints are
 * repo-relative and may point BELOW the item root (`items/lunar-lander/app/dist`),
 * so we cannot just take an entrypoint's dirname. Prefer the conventional
 * `items/<id>`, and otherwise walk a declared entrypoint upwards to the ancestor
 * named after the item.
 */
function itemDirFor(marketplaceId: string, item: MarketplaceItem): string {
  const root = cloneDir(marketplaceId);
  const conventional = path.join(root, "items", item.id);
  const entry = item.app?.entrypoint ?? item.services?.entrypoint ?? item.voiceEngine?.entrypoint
    ?? item.integration?.entrypoint ?? item.serverPlugin?.entrypoint ?? item.spec?.path;
  if (!entry) return conventional;

  let dir = path.join(root, entry);
  while (dir.startsWith(root) && path.basename(dir) !== item.id) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.basename(dir) === item.id ? dir : conventional;
}

function findItem(manifest: MarketplaceManifest, itemId: string): MarketplaceItem {
  const item = manifest.items.find((i) => i.id === itemId);
  if (!item) throw new Error(`Item "${itemId}" not found in marketplace "${manifest.id}".`);
  return item;
}

/** A collision-free spec-store folder id under the user store (N7 de-dup). */
async function uniqueSpecId(base: string): Promise<string> {
  const root = userSpecRoot();
  let id = base;
  for (let n = 2; await pathExists(path.join(root, id)); n++) id = `${base}-${n}`;
  return id;
}

/**
 * Adopt an item's spec: fork its `spec/` folder into the user spec store as a new
 * feature folder (de-duped id), then commit. The fork has no ongoing link to the
 * marketplace — the user owns it.
 */
export async function adoptSpec(marketplaceId: string, itemId: string): Promise<{ storePath: string }> {
  const manifest = await readManifest(marketplaceId);
  const item = findItem(manifest, itemId);
  if (!item.spec) throw new Error(`Item "${itemId}" has no adoptable spec.`);
  const src = path.join(cloneDir(marketplaceId), item.spec.path);
  if (!(await pathExists(src))) throw new Error(`Spec folder missing in marketplace clone: ${item.spec.path}`);

  const destId = await uniqueSpecId(item.id);
  const dest = path.join(userSpecRoot(), destId);
  await fs.cp(src, dest, { recursive: true });
  // Drop any nested .git from the source so it joins the user store cleanly.
  await fs.rm(path.join(dest, ".git"), { recursive: true, force: true }).catch(() => {});
  await commitAll(userSpecRoot(), `adopt ${item.name} from ${manifest.name}`);
  logger().info(COMPONENT, "spec adopted", { marketplaceId, itemId, destId });
  return { storePath: `user-specs/${destId}` };
}

/**
 * Install an item's skill: read the entire skill folder from the marketplace clone
 * and save it into BOS's skill store. SKILL.md becomes the skill content; files
 * under scripts/ become script assets; everything else becomes reference assets.
 */
export async function installSkill(marketplaceId: string, itemId: string): Promise<{ skillId: string }> {
  const manifest = await readManifest(marketplaceId);
  const item = findItem(manifest, itemId);
  if (!item.skill) throw new Error(`Item "${itemId}" has no skill to install.`);

  const skillDir = path.join(cloneDir(marketplaceId), item.skill.path);
  if (!(await pathExists(skillDir))) {
    throw new Error(`Skill folder missing in marketplace clone: ${item.skill.path}`);
  }
  const skillMdPath = path.join(skillDir, "SKILL.md");
  if (!(await pathExists(skillMdPath))) {
    throw new Error(`Skill folder has no SKILL.md: ${item.skill.path}`);
  }

  const content = await fs.readFile(skillMdPath, "utf8");
  const scripts: SkillAsset[] = [];
  const references: SkillAsset[] = [];
  await walkSkillDir(skillDir, scripts, references);

  const saved = await saveSkill({
    name: item.name,
    description: item.description,
    content,
    scripts: scripts.length > 0 ? scripts : undefined,
    references: references.length > 0 ? references : undefined,
    createdBy: "user",
  });

  logger().info(COMPONENT, "skill installed", { marketplaceId, itemId, skillId: saved.id });
  return { skillId: saved.id };
}

/**
 * Install a marketplace ITEM — the unit of installation. An item is a
 * self-contained folder that may bundle an app/ (UI), services/, hooks/,
 * config/, spec/, doc/; installing it lands it under dataDir()/user-apps/<id>/
 * (the user's local marketplace, a GitFS repo) and symlinks each facet into
 * dataDir()/system/<type>/<id> — ONE mechanism for every item shape, whether
 * UI-only, service-only, or both.
 */
export async function installMarketplaceItem(
  marketplaceId: string,
  itemId: string,
): Promise<{ app?: AppManifest; serviceId?: string; pluginId?: string }> {
  const manifest = await readManifest(marketplaceId);
  const item = findItem(manifest, itemId);
  if (!item.app && !item.services && !item.integration && !item.voiceEngine) {
    throw new Error(`Item "${itemId}" has nothing installable (no app, services, integration, or voiceEngine).`);
  }

  // BOS plugin facets (integration + voiceEngine) — install first so the plugin
  // is active by the time the app (if any) is registered.
  let pluginId: string | undefined;
  const pluginFacet = item.integration ?? item.voiceEngine;
  if (pluginFacet) {
    ({ pluginId } = await installBosPlugin(marketplaceId, itemId));
  }

  // Service facet: copies the full item directory into user-apps/<id>/.
  let serviceId: string | undefined;
  if (item.services) {
    ({ serviceId } = await installMarketplaceService(marketplaceId, itemId));
  }

  let app: AppManifest | undefined;
  if (item.app) {
    if (item.app.runtime === "plugin-served") {
      // Plugin-served apps are opened via /api/plugin/<id>/app — no file copy.
      // They're always same-origin (served by BOS) so origin is "local".
      app = await installItemApp(item.id, {
        name: item.name,
        icon: item.app.icon,
        origin: "local",
        marketplaceId: marketplaceId === LOCAL_MARKETPLACE_ID ? undefined : marketplaceId,
        appUrl: `/api/plugin/${item.id}/app`,
      });
    } else {
      // Iframe app: nothing is copied (035 FR-001). The app facet is served
      // through the item symlink, so the item stays where its marketplace put it.
      // `item.app.entrypoint` may point below the item root (e.g.
      // `items/x/app/dist`), so derive the ITEM directory to link, not the app dir.
      const appEntry = path.join(cloneDir(marketplaceId), item.app.entrypoint);
      if (!(await pathExists(appEntry))) {
        throw new Error(`App folder missing in marketplace clone: ${item.app.entrypoint}`);
      }
      if (!item.services) {
        const { installItemLink } = await import("@/system/marketplace/install/symlinkManager");
        await installItemLink(itemDirFor(marketplaceId, item), item.id);
      }
      app = await installItemApp(item.id, {
        name: item.name,
        icon: item.app.icon,
        origin: marketplaceId === LOCAL_MARKETPLACE_ID ? "local" : "marketplace",
        marketplaceId: marketplaceId === LOCAL_MARKETPLACE_ID ? undefined : marketplaceId,
      });
    }
  }

  logger().info(COMPONENT, "item installed", { marketplaceId, itemId, app: !!app, serviceId, pluginId });
  return { app, serviceId, pluginId };
}

/**
 * Install a BOS plugin (integration or voiceEngine facet) from a marketplace.
 * Symlinks the item into dataDir()/system/<id> and activates its plugin facet
 * via the bos-plugin loader. Nothing is copied (035 FR-001).
 */
export async function installBosPlugin(
  marketplaceId: string,
  itemId: string,
): Promise<{ pluginId: string }> {
  const manifest = await readManifest(marketplaceId);
  const item = findItem(manifest, itemId);
  const facet = item.integration ?? item.voiceEngine;
  if (!facet) throw new Error(`Item "${itemId}" has no integration or voiceEngine facet.`);

  const src = path.join(cloneDir(marketplaceId), facet.entrypoint);
  if (!(await pathExists(src))) {
    throw new Error(`Plugin directory missing in marketplace clone: ${facet.entrypoint}`);
  }

  const pluginJsonPath = path.join(src, "bos-plugin.json");
  if (!(await pathExists(pluginJsonPath))) {
    throw new Error(`Item "${itemId}" has no bos-plugin.json — not a BOS plugin.`);
  }

  const pluginManifest = JSON.parse(await fs.readFile(pluginJsonPath, "utf8")) as { id?: string };
  if (!pluginManifest.id) throw new Error("bos-plugin.json missing required 'id' field");

  // NOTHING is copied (035 FR-001/FR-008): a plugin is an ordinary item facet.
  // The item is symlinked into dataDir()/system/<id> and the loader reads its
  // plugin/ facet through that link. dataDir()/bos-plugins/ is gone.
  const { installItemLink } = await import("@/system/marketplace/install/symlinkManager");
  await installItemLink(itemDirFor(marketplaceId, item), item.id);

  const { loadPlugin } = await import("@/lib/bos-plugins/loader");
  await loadPlugin(path.join(itemLinkPath(item.id), "plugin"));

  logger().info(COMPONENT, "bos plugin installed", { marketplaceId, itemId, pluginId: pluginManifest.id });
  return { pluginId: pluginManifest.id };
}

/**
 * Uninstall a BOS plugin. Calls its deactivate() hook via the stored module
 * instance (preserving the factory-function pattern), removes its app store
 * entry if any, then deletes the plugin directory.
 */
export async function uninstallBosPlugin(pluginId: string): Promise<void> {
  const pluginDir = path.join(itemLinkPath(pluginId), "plugin");
  if (!(await pathExists(pluginDir))) return;

  // Use the already-loaded module instance so deactivate() runs with the same
  // sdk-injected closures that activate() used. Re-importing would give a
  // factory function (live-avatar pattern), not the instantiated object.
  const ctx = { pluginId, log: { info: console.log, warn: console.warn, error: console.error } };
  try {
    const { getLoadedPluginModule, unloadPlugin } = await import("@/lib/bos-plugins/loader");
    const mod = getLoadedPluginModule(pluginId);
    if (mod) {
      await mod.deactivate?.(ctx);
    }
    unloadPlugin(pluginId);
  } catch (err) {
    logger().warn(COMPONENT, `deactivate() failed for plugin ${pluginId}`, { error: (err as Error).message });
  }

  // Remove the app store entry if this plugin had a plugin-served app.
  try {
    const { uninstallApp, readApp } = await import("@/lib/apps/store");
    const app = await readApp(pluginId);
    if (app?.appUrl) await uninstallApp(pluginId);
  } catch {
    // App may not exist — not an error.
  }

  // Uninstall = remove the item symlink (035 FR-003). NEVER delete pluginDir:
  // it resolves THROUGH the symlink into the marketplace clone (or the user's own
  // repo), so removing it would destroy the item's source rather than uninstall it.
  const { uninstallItemLink } = await import("@/system/marketplace/install/symlinkManager");
  await uninstallItemLink(pluginId);
  logger().info(COMPONENT, "bos plugin uninstalled", { pluginId });
}

/**
 * Uninstall an installed item, whatever it is made of — the mirror of
 * installMarketplaceItem.
 *
 * Facets come from the INSTALLED item (the shared scan), not from a marketplace
 * manifest: uninstalling must keep working after the marketplace it came from has
 * been removed, and after the manifest stopped declaring a facet that is still
 * installed here.
 *
 * Order matters — each step needs the item link the next one removes: deactivate
 * the plugin while its files are still reachable, stop the service before its
 * definition disappears, then drop the app. Every step already ends in
 * `uninstallItemLink`, which is idempotent, so the last one to run wins and the
 * link is gone either way (035 FR-003).
 */
export async function uninstallMarketplaceItem(itemId: string): Promise<void> {
  const item = await getInstalledItem(itemId);
  if (!item) throw new Error(`"${itemId}" is not installed.`);

  if (item.facets.plugin) await uninstallBosPlugin(itemId);
  if (item.facets.service) {
    const { uninstallService } = await import("@/system/marketplace/install/serviceInstaller");
    await uninstallService(itemId);
  }
  if (item.facets.app) {
    const { uninstallApp } = await import("@/lib/apps/store");
    await uninstallApp(itemId);
  }

  // A plugin-only item's link is removed by uninstallBosPlugin; a facet-less or
  // broken item still has to lose its link, so make the removal explicit.
  const { uninstallItemLink } = await import("@/system/marketplace/install/symlinkManager");
  await uninstallItemLink(itemId);
  logger().info(COMPONENT, "item uninstalled", { itemId, facets: Object.keys(item.facets) });
}

/**
 * Install a server plugin from a marketplace. Validates the plugin manifest,
 * copies files to dataDir()/plugins/<id>/, and registers it.
 */
export async function installServerPlugin(
  marketplaceId: string,
  itemId: string,
): Promise<{ pluginId: string }> {
  const manifest = await readManifest(marketplaceId);
  const item = findItem(manifest, itemId);

  // Use item.serverPlugin.entrypoint if available, falling back to item.app?.entrypoint.
  const pluginEntrypoint = item.serverPlugin?.entrypoint ?? item.app?.entrypoint;
  if (!pluginEntrypoint) {
    throw new Error(`Item "${itemId}" has no serverPlugin or app entrypoint — not a server plugin.`);
  }

  // Read the plugin.json from the marketplace item's directory.
  const itemDir = path.join(cloneDir(marketplaceId), pluginEntrypoint);
  const pluginJsonPath = path.join(itemDir, "plugin.json");

  if (!(await pathExists(pluginJsonPath))) {
    throw new Error(`Item "${itemId}" has no plugin.json — not a server plugin.`);
  }

  const pluginJsonContent = await fs.readFile(pluginJsonPath, "utf8");
  const pluginManifest = JSON.parse(pluginJsonContent) as {
    id?: string;
    name?: string;
    version?: string;
    type?: string;
    provides?: string[];
  };

  if (!pluginManifest.id) throw new Error("plugin.json missing required 'id' field");
  if (pluginManifest.type !== "server-plugin") throw new Error("plugin.json type must be 'server-plugin'");

  // Install the plugin files to dataDir()/plugins/<id>/.
  const { installPlugin } = await import("@/lib/plugins/loader");
  await installPlugin(itemDir, {
    id: pluginManifest.id,
    name: pluginManifest.name ?? item.name,
    version: pluginManifest.version ?? "0.0.0",
    type: "server-plugin",
    provides: (pluginManifest.provides as never[]) ?? [],
    description: item.description,
  });

  // Auto-activate the plugin.
  const { activatePlugin } = await import("@/lib/plugins/registry");
  await activatePlugin(pluginManifest.id);

  logger().info(COMPONENT, "server plugin installed", {
    marketplaceId,
    itemId,
    pluginId: pluginManifest.id,
  });
  return { pluginId: pluginManifest.id };
}

/**
 * Install a service daemon item from a marketplace (user-specs/002-service-daemons).
 * Copies the item's full directory (services/, config/, and any of spec/, doc/,
 * app/, hooks/) into dataDir()/user-apps/<id>/ — the user's local marketplace —
 * then creates the dataDir()/system/ symlinks via installService(), exactly the
 * same division of labor as installServerPlugin: this function does
 * "Step 1" (get the item onto disk somewhere durable); serviceInstaller.ts does
 * the rest (validate + symlink + register).
 */
export async function installMarketplaceService(marketplaceId: string, itemId: string): Promise<{ serviceId: string }> {
  const manifest = await readManifest(marketplaceId);
  const item = findItem(manifest, itemId);
  if (!item.services) throw new Error(`Item "${itemId}" has no services entrypoint.`);

  const src = path.join(cloneDir(marketplaceId), item.services.entrypoint);
  if (!(await pathExists(src))) throw new Error(`Service folder missing in marketplace clone: ${item.services.entrypoint}`);
  if (!(await pathExists(path.join(src, "services", "service.json")))) {
    throw new Error(`Item "${itemId}" has no services/service.json — not a service item.`);
  }

  // NOTHING is copied (035 FR-001). installService symlinks dataDir()/system/<id>
  // straight at the item where it already lives, so `git pull` on the
  // marketplace updates the installed service with no reinstall — and the user's
  // own marketplace never accumulates copies of other people's items.
  await installService(src, item.id);

  logger().info(COMPONENT, "service installed", { marketplaceId, itemId, serviceId: item.id });
  return { serviceId: item.id };
}
