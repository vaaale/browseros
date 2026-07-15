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
    const manifest = validateManifest(JSON.parse(await fs.readFile(path.join(tmp, MANIFEST), "utf8")));
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
 * Install an item's app: copy its pre-built (static) files into the local app
 * store, tagged with `origin: "marketplace"` so it runs in the opaque-origin
 * sandbox. The app must ship an index.html (built output), not source.
 */
export async function installApp(
  marketplaceId: string,
  itemId: string,
): Promise<{ appId: string; name: string }> {
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
  const m = await storeInstallApp({
    name: item.name,
    icon: item.app.icon,
    files,
    origin: "marketplace",
    marketplaceId,
  });
  logger().info(COMPONENT, "app installed", { marketplaceId, itemId, appId: m.id });
  return { appId: m.id, name: m.name };
}
