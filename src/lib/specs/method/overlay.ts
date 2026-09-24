// 048 M2 / T006 — the pack overlay (FR-004, FR-004a).
//
// `data/method-packs/<packId>/` — user-owned content that SHADOWS an installed
// pack's own. It exists because a method pack's root is read-only (it is an
// installed item, overwritten on upgrade) and BMAD's whole premise is that its
// cast gets customised: BMB's `create-agent` needs somewhere to write that
// survives the next `app_install`.
//
// THIS IS AN OVERLAY, NOT AN INSTALL PATH, and the distinction is load-bearing.
// BOS's rule (035) is one install mechanism — the item symlink — and "install
// copies nothing". Nothing here installs: the pack is still installed exactly
// once, as an item symlink, and remains the only thing `listInstalledItems()`
// knows about. The overlay is a WRITE DESTINATION FOR USER MODIFICATIONS TO
// ALREADY-INSTALLED CONTENT, which is precisely what `itemConfigDir`
// (`installed.ts:37` — "BOS-owned mutable config, seeded from the item's
// defaults at install") already is for config. This extends that convention
// from config to content, and must not acquire install semantics.

import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { logger } from "@/lib/logging/server-logger";

const COMPONENT = "specs.method.overlay";

/** Root of every pack overlay. */
export function overlayRoot(root?: string): string {
  return path.join(root ?? dataDir(), "method-packs");
}

/** One pack's overlay. Deliberately OUTSIDE the item: writing inside it would
 *  put user content in a tree the marketplace overwrites on upgrade, which is
 *  exactly what US3 says must not happen. */
export function packOverlayDir(packId: string, root?: string): string {
  return path.join(overlayRoot(root), packId);
}

/** The overlay's agents directory, mirroring the pack's own layout so ONE
 *  precedence rule can walk both without a special case (FR-002a). */
export function overlayAgentsDir(packId: string, root?: string): string {
  return path.join(packOverlayDir(packId, root), "agents");
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}

/** Does this pack have an overlay with anything in it?
 *
 *  Called with a packId that is ALREADY KNOWN TO BE INSTALLED — see
 *  `orphanOverlays` for why enumeration never runs the other way. */
export async function hasOverlay(packId: string, root?: string): Promise<boolean> {
  return exists(overlayAgentsDir(packId, root));
}

/** Overlay directories whose pack is NOT installed (FR-004a).
 *
 *  These are INERT: they contribute nothing, and are reported so a user can see
 *  why their customisations stopped applying. Reported rather than resurrected,
 *  because an overlay that could bring content into existence on its own would
 *  BE a second install path — BOS would be discovering packs that were never
 *  installed, and 035's one-mechanism rule would be broken.
 *
 *  Note the direction of the scan everywhere else: agent roots are built by
 *  iterating INSTALLED PACKS and asking each whether it has an overlay. This
 *  function is the only place that lists the overlay directory at all, and it
 *  exists purely to report. */
export async function orphanOverlays(installedPackIds: Set<string>, root?: string): Promise<string[]> {
  const dir = overlayRoot(root);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const orphans = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .filter((id) => !installedPackIds.has(id));
  if (orphans.length) {
    logger().info(COMPONENT, "overlay present for uninstalled pack(s)", { packIds: orphans });
  }
  return orphans.sort();
}

/** Create the overlay's directories so a write tool has somewhere to land.
 *
 *  Called at INSTALL, from a packId that is being installed — never as a
 *  side effect of reading, which would let a stray read materialise an overlay
 *  and blur the inertness rule above. */
export async function ensureOverlay(packId: string, root?: string): Promise<string> {
  const dir = packOverlayDir(packId, root);
  await fs.mkdir(path.join(dir, "agents"), { recursive: true });
  return dir;
}

/** Remove a pack's overlay. NOT called on uninstall — a user's customisations
 *  outliving an uninstall is deliberate, so reinstalling the pack restores
 *  them rather than silently discarding work. Exposed for an explicit
 *  "discard my customisations" action. */
export async function removeOverlay(packId: string, root?: string): Promise<void> {
  await fs.rm(packOverlayDir(packId, root), { recursive: true, force: true });
}
