import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir } from "@/os/data-dir";
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
 * Scan dataDir()/user-apps/ and build a MarketplaceManifest from whatever's
 * actually there — a `services/service.json` makes an item a `services`
 * entry, an `app/index.html` makes it an `app` entry (same item can be both,
 * e.g. the Terminal reference item), a non-empty `spec/` makes it a `spec`
 * entry. This is what makes user-apps/ "the user's local marketplace" (per
 * user-specs/002-service-daemons) actually auto-discovered rather than
 * requiring a hand-maintained manifest.
 */
async function scanUserAppsManifest(): Promise<MarketplaceManifest> {
  const root = userAppsDir();
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
        services = { entrypoint: id, version };
      } catch {
        // Malformed service.json — skip the services entry, still consider app/spec below.
      }
    }

    // Local items install with origin "local" (same-origin iframe), so an
    // app/ facet is always exposable — no opaque-origin caveats apply here.
    let app: MarketplaceItemApp | undefined;
    if (await pathExists(path.join(itemDir, "app", "index.html"))) {
      app = { entrypoint: `${id}/app`, runtime: "iframe", version };
    }

    let spec: MarketplaceItemSpec | undefined;
    const specDir = path.join(itemDir, "spec");
    if ((await fs.readdir(specDir).catch(() => [])).length > 0) {
      spec = { path: `${id}/spec`, version };
    }

    if (!services && !app && !spec) continue; // not a recognised item shape

    items.push({ id, name, description, app, spec, services });
  }

  return {
    id: LOCAL_MARKETPLACE_ID,
    name: "My Apps",
    version: "1.0.0",
    description: "Items in your dataDir()/user-apps/ — install them the same way as a remote marketplace.",
    items,
  };
}

async function readManifest(id: string): Promise<MarketplaceManifest> {
  // The local user-apps/ marketplace is always freshly scanned, in-memory
  // only — never written to disk. That directory is the user's own GitFS
  // repo (dataDir()/user-apps/, the same concept as user-specs/, possibly
  // pushed to a real remote), so BOS must never write a generated artifact
  // into it.
  if (id === LOCAL_MARKETPLACE_ID) return scanUserAppsManifest();
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

    if (manifest.id === LOCAL_MARKETPLACE_ID) {
      throw new Error(`"${LOCAL_MARKETPLACE_ID}" is a reserved marketplace id — it already names your local user-apps/ folder.`);
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
  await writeConfig((await readConfig()).filter((m) => m.id !== id));
  await fs.rm(cloneDir(id), { recursive: true, force: true }).catch(() => {});
  logger().info(COMPONENT, "marketplace removed", { id });
}

/** Pull the latest for a registered marketplace. The local user-apps/
 *  "marketplace" is always freshly scanned on every read (see readManifest),
 *  so there's nothing to do here for it — BOS doesn't manage that repo's git
 *  remote; the user does, the same way they manage user-specs/. */
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
    const local: RegisteredMarketplace = {
      id: LOCAL_MARKETPLACE_ID,
      url: "(local) dataDir()/user-apps/",
      name: "My Apps",
      addedAt: "",
      lastSynced: null,
    };
    try {
      entries.unshift({ ...local, items: (await readManifest(LOCAL_MARKETPLACE_ID)).items });
    } catch (err) {
      entries.unshift({ ...local, items: [], error: (err as Error).message });
    }
  }

  return entries;
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
): Promise<{ app?: AppManifest; serviceId?: string }> {
  const manifest = await readManifest(marketplaceId);
  const item = findItem(manifest, itemId);
  if (!item.app && !item.services) {
    throw new Error(`Item "${itemId}" has nothing installable (no app or services).`);
  }

  // Service facet first: it copies the FULL item directory (app/ included)
  // into user-apps/<id>/ and creates all its symlinks.
  let serviceId: string | undefined;
  if (item.services) {
    ({ serviceId } = await installMarketplaceService(marketplaceId, itemId));
  }

  let app: AppManifest | undefined;
  if (item.app) {
    // App-only remote items: copy just their app folder into user-apps/<id>/app/.
    // (Local items already live in user-apps/; service items were copied above.)
    if (!item.services && marketplaceId !== LOCAL_MARKETPLACE_ID) {
      const src = path.join(cloneDir(marketplaceId), item.app.entrypoint);
      if (!(await pathExists(src))) {
        throw new Error(`App folder missing in marketplace clone: ${item.app.entrypoint}`);
      }
      const dest = path.join(userAppsDir(), item.id, "app");
      await fs.cp(src, dest, { recursive: true });
      await fs.rm(path.join(dest, ".git"), { recursive: true, force: true }).catch(() => undefined);
      await commitAll(userAppsDir(), `adopt ${item.name} from ${manifest.name}`);
    }
    // Local items are the user's own content → same-origin iframe; remote
    // marketplace items are untrusted → tagged for the opaque-origin sandbox.
    app = await installItemApp(item.id, {
      name: item.name,
      icon: item.app.icon,
      origin: marketplaceId === LOCAL_MARKETPLACE_ID ? "local" : "marketplace",
      marketplaceId: marketplaceId === LOCAL_MARKETPLACE_ID ? undefined : marketplaceId,
    });
  }

  logger().info(COMPONENT, "item installed", { marketplaceId, itemId, app: !!app, serviceId });
  return { app, serviceId };
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

  const dest = path.join(dataDir(), "user-apps", item.id);
  // Item already lives in user-apps/ (src === dest) when installing from the
  // local marketplace — fs.cp refuses to copy a directory onto itself, and
  // there's nothing to copy anyway.
  if (marketplaceId !== LOCAL_MARKETPLACE_ID) {
    await fs.cp(src, dest, { recursive: true });
    await fs.rm(path.join(dest, ".git"), { recursive: true, force: true }).catch(() => undefined);
    // user-apps/ is the user's own GitFS repo (same concept as user-specs/) —
    // commit the copy so it shows up in that repo's history, same as adoptSpec().
    await commitAll(path.join(dataDir(), "user-apps"), `adopt ${item.name} from ${manifest.name}`);
  }

  await installService(dest, item.id);

  logger().info(COMPONENT, "service installed", { marketplaceId, itemId, serviceId: item.id });
  return { serviceId: item.id };
}
