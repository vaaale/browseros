import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { writeFileAtomic } from "@/os/atomic-write";
import { itemConfigDir } from "./installed";
import type { AppCapability } from "@/os/types";

/**
 * BOS SDK capability grants, stored as BOS-owned state (035).
 *
 *   dataDir()/system/config/<item-id>/capabilities.json
 *
 * They deliberately do NOT live in the item's `app.json`. That file belongs to
 * whoever authored the item, and for a marketplace item it sits in a read-only
 * clone — so a permission grant held there could silently widen itself on the
 * next `git pull`. A grant is something BOS gives, not something an item claims.
 *
 * Note: because seeded config survives uninstall, so do grants. Reinstalling an
 * item under the same id therefore inherits the previous grants — knowingly
 * accepted, since it keeps a user's settings across a reinstall.
 */

const FILE = "capabilities.json";

const capabilitiesPath = (id: string) => path.join(itemConfigDir(id), FILE);

export async function readCapabilities(id: string): Promise<AppCapability[] | undefined> {
  try {
    const raw = JSON.parse(await fs.readFile(capabilitiesPath(id), "utf8")) as { capabilities?: unknown };
    return Array.isArray(raw.capabilities) ? (raw.capabilities as AppCapability[]) : undefined;
  } catch {
    return undefined;
  }
}

export async function writeCapabilities(id: string, capabilities: AppCapability[]): Promise<void> {
  const dir = itemConfigDir(id);
  await fs.mkdir(dir, { recursive: true });
  await writeFileAtomic(capabilitiesPath(id), JSON.stringify({ capabilities }, null, 2) + "\n");
}

/**
 * Grants for an item, migrating a pre-035 grant that still lives in the item's
 * `app.json` into BOS-owned state on first read. Returns undefined when the item
 * has never been granted anything.
 */
export async function resolveCapabilities(id: string, fromManifest?: AppCapability[]): Promise<AppCapability[] | undefined> {
  const owned = await readCapabilities(id);
  if (owned) return owned;
  if (fromManifest && fromManifest.length > 0) {
    await writeCapabilities(id, fromManifest).catch(() => undefined);
    return fromManifest;
  }
  return undefined;
}
