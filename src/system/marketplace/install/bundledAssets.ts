import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { createHash } from "crypto";
import { dataDir } from "@/os/data-dir";
import { listInstalledItems } from "@/system/items/installed";
import { logger } from "@/lib/logging";

const COMPONENT = "marketplace.bundled-assets";

/**
 * Bundled agents/skills carried by a marketplace item (040-okf-knowledge-base).
 *
 * These are COPIED into data/agents/<id>/ and data/skills/<id>/ — deliberately
 * NOT symlinked like the item itself (035). Agents and skills are designed to be
 * locally mutable: the user edits them in Settings, and the skill reflective
 * optimizer rewrites a skill's own content over time. A symlink would let the
 * next `git pull` of a marketplace clone silently overwrite that local work.
 * Copying matches what BOS already does for its own built-ins (seed/agents/ ->
 * data/agents/, seed/skills/ -> data/skills/ in subagents/store.ts and
 * skills/store.ts) — this extends that same mechanism to a new source, rather
 * than inventing a second install path.
 *
 * Update safety rides on a content hash recorded at install time:
 *   - hash still matches what's on disk  -> untouched since install -> replace
 *   - hash differs                       -> the user (or an agent) changed it ->
 *                                           report a conflict, touch nothing
 *   - no recorded provenance             -> unknown -> treated as diverged, so a
 *                                           pre-existing copy is never clobbered
 * The same shape as dpkg's conffile prompt: silent when safe, ask when not.
 */

export type BundledAssetKind = "agent" | "skill";

export interface BundledAssetConflict {
  kind: BundledAssetKind;
  /** Asset id (its directory name), e.g. "okf-ingest". */
  id: string;
  /** The item that carries the incoming version. */
  itemId: string;
  /** Absolute path to the incoming copy inside the item. */
  sourcePath: string;
  /** Absolute path to the installed copy under data/. */
  destPath: string;
  reason: "diverged" | "unknown-provenance";
}

export interface SeedBundledAssetsResult {
  installed: { kind: BundledAssetKind; id: string }[];
  replaced: { kind: BundledAssetKind; id: string }[];
  conflicts: BundledAssetConflict[];
}

const PROVENANCE_FILE = ".installed-from.json";

interface Provenance {
  itemId: string;
  version?: string;
  contentHash: string;
}

const destRootFor = (kind: BundledAssetKind, root?: string) => path.join(root ?? dataDir(), kind === "agent" ? "agents" : "skills");
const sourceRootFor = (itemPath: string, kind: BundledAssetKind) =>
  path.join(itemPath, kind === "agent" ? "agents" : "skills");

async function pathExists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}

/**
 * Hash a whole asset directory, not just its entry file. A skill can carry
 * scripts/ and references/ alongside SKILL.md; hashing only the markdown would
 * call a skill "untouched" after its helper script was edited, and then
 * overwrite that edit on the next item update.
 *
 * Paths are included in the digest (so a rename is a change) and sorted (so the
 * digest doesn't depend on readdir order). The provenance file itself is
 * excluded — it records the hash, so including it would be self-referential.
 */
async function hashDirectory(dir: string): Promise<string> {
  const files: string[] = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name !== PROVENANCE_FILE) files.push(full);
    }
  };
  await walk(dir);
  files.sort();

  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(dir, file));
    hash.update("\0");
    hash.update(await fs.readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function readProvenance(assetDir: string): Promise<Provenance | null> {
  try {
    const raw = await fs.readFile(path.join(assetDir, PROVENANCE_FILE), "utf8");
    const parsed = JSON.parse(raw) as Provenance;
    return typeof parsed?.contentHash === "string" ? parsed : null;
  } catch {
    return null;
  }
}

async function writeProvenance(assetDir: string, provenance: Provenance): Promise<void> {
  await fs.writeFile(path.join(assetDir, PROVENANCE_FILE), JSON.stringify(provenance, null, 2) + "\n", "utf8");
}

/** Copy one asset directory into place and stamp its provenance. */
async function copyAsset(sourcePath: string, destPath: string, itemId: string, version?: string): Promise<void> {
  await fs.rm(destPath, { recursive: true, force: true });
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.cp(sourcePath, destPath, { recursive: true });
  await writeProvenance(destPath, { itemId, version, contentHash: await hashDirectory(sourcePath) });
}

/**
 * Apply the resolution the user chose for a conflict `seedItemBundledAssets`
 * reported. "keep" is a no-op by design — the local copy already wins by
 * default, so nothing was overwritten while the prompt was pending.
 */
export async function resolveBundledAssetConflict(
  conflict: BundledAssetConflict,
  resolution: "keep" | "replace",
  version?: string,
): Promise<void> {
  if (resolution === "keep") return;
  await copyAsset(conflict.sourcePath, conflict.destPath, conflict.itemId, version);
}

async function seedOneKind(
  itemPath: string,
  itemId: string,
  kind: BundledAssetKind,
  version: string | undefined,
  result: SeedBundledAssetsResult,
  root?: string,
): Promise<void> {
  const sourceRoot = sourceRootFor(itemPath, kind);
  const entries = await fs.readdir(sourceRoot, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const sourcePath = path.join(sourceRoot, id);
    const destPath = path.join(destRootFor(kind, root), id);

    if (!(await pathExists(destPath))) {
      await copyAsset(sourcePath, destPath, itemId, version);
      result.installed.push({ kind, id });
      continue;
    }

    const provenance = await readProvenance(destPath);
    if (!provenance) {
      // A copy we didn't install, or one predating provenance tracking. Either
      // way we can't prove it's safe to overwrite, so we don't.
      result.conflicts.push({ kind, id, itemId, sourcePath, destPath, reason: "unknown-provenance" });
      continue;
    }

    const current = await hashDirectory(destPath);
    if (current !== provenance.contentHash) {
      result.conflicts.push({ kind, id, itemId, sourcePath, destPath, reason: "diverged" });
      continue;
    }

    // Untouched since install. Replacing is safe — but skip the write entirely
    // when the incoming copy is byte-identical, so a reinstall of the same
    // version doesn't churn mtimes.
    if ((await hashDirectory(sourcePath)) === current) continue;
    await copyAsset(sourcePath, destPath, itemId, version);
    result.replaced.push({ kind, id });
  }
}

/**
 * Copy an item's bundled agents/skills into data/, reporting anything that
 * diverged locally instead of overwriting it. Called from installItemLink()
 * alongside seedItemConfig().
 *
 * Never throws: a malformed or absent `agents/`/`skills/` directory just means
 * there is nothing to seed. Install must not fail because a bundled extra was
 * unreadable — the item's own app/service facets are the primary deliverable.
 */
export async function seedItemBundledAssets(
  itemPath: string,
  itemId: string,
  version?: string,
  /** A FEATURE BRANCH's data clone to seed into instead of the live root
   *  (lib/devharness/branch-data-root.ts). Omitted = the live root. */
  root?: string,
): Promise<SeedBundledAssetsResult> {
  const result: SeedBundledAssetsResult = { installed: [], replaced: [], conflicts: [] };
  try {
    await seedOneKind(itemPath, itemId, "agent", version, result, root);
    await seedOneKind(itemPath, itemId, "skill", version, result, root);
  } catch (err) {
    // Best-effort: keep whatever was seeded before the failure — but SAY so.
    // Swallowing this silently once made a broken seed indistinguishable from
    // an item that simply bundles nothing.
    logger().warn(COMPONENT, "seed.failed", { itemId, itemPath, error: (err as Error).message });
  }
  if (result.conflicts.length) await recordPendingConflicts(result.conflicts, root);
  if (result.installed.length || result.replaced.length || result.conflicts.length) {
    logger().info(COMPONENT, "seed.applied", {
      itemId,
      installed: result.installed.map((a) => `${a.kind}:${a.id}`),
      replaced: result.replaced.map((a) => `${a.kind}:${a.id}`),
      conflicts: result.conflicts.map((c) => `${c.kind}:${c.id}`),
    });
  }
  return result;
}

// ── Reconciliation ───────────────────────────────────────────────────────────
// Install-time seeding alone is not enough, for a reason that only shows up in
// practice: you do not reinstall an item you already have installed. An item
// that GAINS a bundled agent/skill — because its author added one, or because
// it was installed by a BOS build that predates this feature — would never pick
// it up, since the one hook that copies assets only fires from installItemLink.
//
// So bundled assets are also reconciled lazily on first agent/skill read, which
// is exactly how BOS already seeds its OWN built-ins (seed/agents -> data/agents
// in subagents/store.ts, seed/skills -> data/skills in skills/store.ts). Same
// idempotence guarantees apply: unchanged assets are skipped, and a locally
// diverged one is never overwritten — it becomes a pending conflict instead.

let reconcilePass: Promise<void> | undefined;

async function reconcileOnce(): Promise<void> {
  const items = await listInstalledItems().catch(() => []);
  for (const item of items) {
    if (item.broken) continue;
    await seedItemBundledAssets(item.itemPath, item.id).catch(() => {});
  }
}

/**
 * Copy any not-yet-installed bundled agents/skills from every installed item.
 * Memoized per process — both stores call it and only one scan runs. Never
 * throws: a failure here must not block reading agents/skills.
 */
export async function reconcileInstalledItemAssets(): Promise<void> {
  if (!reconcilePass) {
    reconcilePass = reconcileOnce().catch((err) => {
      logger().warn(COMPONENT, "reconcile.failed", { error: (err as Error).message });
    });
  }
  return reconcilePass;
}

// ── Pending conflicts ────────────────────────────────────────────────────────
// Conflicts outlive the install that produced them. An install can happen with
// nobody watching — an agent calling app_build, a headless marketplace sync —
// so "return it to the caller and hope someone renders it" would silently drop
// the prompt and leave the user on a stale bundled agent forever. Persisting
// them lets Settings surface the decision whenever the user next looks.

/** `root` follows the install's resolved data root: a conflict raised while
 *  seeding into a FEATURE BRANCH's clone must be queued THERE, so the prompt
 *  (and the resolution, which rewrites paths under the same root) is surfaced
 *  by the version that actually owns those assets. Queueing it in base would
 *  ask the user about assets base does not have. */
const pendingFile = (root?: string) => path.join(root ?? dataDir(), "system", "bundled-asset-conflicts.json");

async function readPending(root?: string): Promise<BundledAssetConflict[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(pendingFile(root), "utf8"));
    return Array.isArray(parsed) ? (parsed as BundledAssetConflict[]) : [];
  } catch {
    return [];
  }
}

async function writePending(conflicts: BundledAssetConflict[], root?: string): Promise<void> {
  await fs.mkdir(path.dirname(pendingFile(root)), { recursive: true });
  await fs.writeFile(pendingFile(root), JSON.stringify(conflicts, null, 2) + "\n", "utf8");
}

const sameAsset = (a: BundledAssetConflict, b: BundledAssetConflict) => a.kind === b.kind && a.id === b.id;

async function recordPendingConflicts(conflicts: BundledAssetConflict[], root?: string): Promise<void> {
  const existing = await readPending(root);
  // Re-installing replaces a stale entry for the same asset rather than
  // stacking duplicates the user would have to dismiss one by one.
  const merged = [...existing.filter((e) => !conflicts.some((c) => sameAsset(c, e))), ...conflicts];
  // Same root it was read from — reading the branch's queue and writing back to
  // base would both lose the merge and corrupt base's queue with the branch's
  // entries.
  await writePending(merged, root).catch(() => {});
}

/** Conflicts awaiting a keep-vs-replace decision. */
export async function listPendingBundledAssetConflicts(): Promise<BundledAssetConflict[]> {
  return readPending();
}

/** Resolve one pending conflict and drop it from the pending list. */
export async function resolvePendingBundledAssetConflict(
  kind: BundledAssetKind,
  id: string,
  resolution: "keep" | "replace",
): Promise<{ resolved: boolean }> {
  const pending = await readPending();
  const conflict = pending.find((c) => c.kind === kind && c.id === id);
  if (!conflict) return { resolved: false };
  await resolveBundledAssetConflict(conflict, resolution);
  await writePending(pending.filter((c) => !(c.kind === kind && c.id === id)));
  return { resolved: true };
}
