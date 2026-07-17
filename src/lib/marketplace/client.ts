import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir } from "@/os/data-dir";
import { writeFileAtomic } from "@/os/atomic-write";
import { commitAll } from "@/lib/gitfs/store";
import { userSpecRoot } from "@/lib/specs/spec-mount";
import { installApp as storeInstallApp } from "@/lib/apps/store";
import { readProjectDir } from "@/lib/apps/build";
import { logger } from "@/lib/logging/server-logger";
import { saveSkill, type SkillAsset } from "@/lib/agent/skills/store";
import type { AppManifest } from "@/os/types";
import {
  validateManifest,
  validateMarketplaceUrl,
  type MarketplaceManifest,
  type MarketplaceItem,
  type RegisteredMarketplace,
} from "./schema";

// Marketplace client (028): register remote git repos, sync them, and either
// ADOPT a spec (fork into the user spec store) or install/run an app. Untrusted
// input — every git URL is allowlisted and every marketplace.json validated
// before use, and git runs via execFile (no shell) so a hostile URL can't inject
// a command.

const exec = promisify(execFile);
const COMPONENT = "marketplace";

const clonesDir = () => path.join(dataDir(), "marketplace");
const configFile = () => path.join(dataDir(), "config", "marketplaces.json");
const cloneDir = (id: string) => path.join(clonesDir(), id);
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

async function readManifest(id: string): Promise<MarketplaceManifest> {
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
  await writeConfig((await readConfig()).filter((m) => m.id !== id));
  await fs.rm(cloneDir(id), { recursive: true, force: true }).catch(() => {});
  logger().info(COMPONENT, "marketplace removed", { id });
}

/** Pull the latest for a registered marketplace. */
export async function syncMarketplace(id: string): Promise<void> {
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

/** All registered marketplaces with their (validated) items — for the app UI. */
export async function listCatalog(): Promise<MarketplaceCatalogEntry[]> {
  const registered = await readConfig();
  return Promise.all(
    registered.map(async (m) => {
      try {
        return { ...m, items: (await readManifest(m.id)).items };
      } catch (err) {
        return { ...m, items: [], error: (err as Error).message };
      }
    }),
  );
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
 * Install an item's app: copy its pre-built (static) files into the local app
 * store, tagged with `origin: "marketplace"` so it runs in the opaque-origin
 * sandbox. The app must ship an index.html (built output), not source.
 */
export async function installApp(marketplaceId: string, itemId: string): Promise<AppManifest> {
  const manifest = await readManifest(marketplaceId);
  const item = findItem(manifest, itemId);
  if (!item.app) throw new Error(`Item "${itemId}" has no app to install.`);
  const src = path.join(cloneDir(marketplaceId), item.app.entrypoint);
  if (!(await pathExists(src))) {
    throw new Error(`App folder missing in marketplace clone: ${item.app.entrypoint}`);
  }
  const files = await readProjectDir(src);
  if (!files["index.html"]) {
    throw new Error("Marketplace app has no index.html (it must ship pre-built static files).");
  }
  const installed = await storeInstallApp({
    name: item.name,
    icon: item.app.icon,
    files,
    origin: "marketplace",
    marketplaceId,
  });
  logger().info(COMPONENT, "app installed", { marketplaceId, itemId, appId: installed.id });
  return installed;
}
