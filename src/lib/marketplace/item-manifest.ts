import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir } from "@/os/data-dir";
import type { InstalledItem } from "@/system/items/installed";
import { validateManifest, type MarketplaceManifest } from "./schema";

// A lightweight, read-only counterpart to marketplace/client.ts's readManifest()
// (028) — used ONLY for the best-effort item metadata lookups below. Kept as
// its own module, deliberately independent of client.ts, so item-stores.ts
// (a Specs-layer file) can read an item's display name/origin without
// statically importing client.ts — that edge used to close a real circular-
// dependency chain: client.ts -> spec-mount.ts (for userSpecRoot) ->
// os/fs/spec-fs.ts -> stores.ts (for STORE_MANIFEST) -> item-stores.ts ->
// back to client.ts. This module has no such path back to stores.ts.
//
// Trade-off: for the LOCAL marketplace, client.ts's readManifest() runs a full
// reconciliation (discovers new items, prunes vanished ones, commits) before
// reading; this module reads user-apps/marketplace.json as-is. That's fine
// here — both lookups below were already best-effort with a graceful
// id-derived fallback, so an unreconciled manifest just means a temporarily
// plainer name until something else (e.g. opening the Marketplace app)
// reconciles it — never a hard failure.

const LOCAL_MARKETPLACE_ID = "user-apps";
const MANIFEST_FILE = "marketplace.json";

const cloneDir = (id: string) => (id === LOCAL_MARKETPLACE_ID ? path.join(dataDir(), "user-apps") : path.join(dataDir(), "marketplace", id));

function toDisplayName(slug: string): string {
  return slug.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

async function readManifestRaw(id: string): Promise<MarketplaceManifest | null> {
  try {
    const raw = await fs.readFile(path.join(cloneDir(id), MANIFEST_FILE), "utf8");
    return validateManifest(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** An installed item's human display name, resolved from its source manifest
 *  (local `user-apps` or the marketplace it was cloned from). Falls back to a
 *  title-cased version of the item id if the source manifest is unreadable —
 *  e.g. the marketplace it came from was since removed while the item stays
 *  installed. Never throws. */
export async function getItemDisplayName(item: InstalledItem): Promise<string> {
  const manifest = await readManifestRaw(item.marketplaceId ?? LOCAL_MARKETPLACE_ID);
  const entry = manifest?.items.find((i) => i.id === item.id);
  return entry?.name?.trim() || toDisplayName(item.id);
}

/** Where an installed item came from, as a short human label — "local" for
 *  the user's own `user-apps`, or the source marketplace's display name.
 *  Falls back to the raw marketplace id if its manifest can no longer be
 *  read (e.g. the marketplace was removed while the item stayed installed),
 *  or to "unknown" for `deriveOrigin()`'s untrusted-symlink fallback (origin
 *  "marketplace" with no marketplaceId at all) — that case must never read as
 *  "local", which `!item.marketplaceId` alone would have wrongly implied. */
export async function getItemOriginLabel(item: InstalledItem): Promise<string> {
  if (item.origin === "local") return "local";
  if (!item.marketplaceId) return "unknown";
  const manifest = await readManifestRaw(item.marketplaceId);
  return manifest?.name || item.marketplaceId;
}
