import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { createHash } from "crypto";
import { dataDir } from "@/os/data-dir";
import { PROVENANCE_FILE, isAssetBookkeeping } from "@/os/asset-bookkeeping";
import { listInstalledItems, itemLinkPath } from "@/system/items/installed";
import { logger } from "@/lib/logging";

const COMPONENT = "marketplace.bundled-assets";

/**
 * Bundled agents/skills carried by a marketplace item (040-okf-knowledge-base).
 *
 * SKILLS of an INSTALLED item are SYMLINKED — `data/skills/<id>` is a RELATIVE
 * link `../system/<itemId>/skills/<id>` routed through the 035 item link — and
 * are therefore READ-ONLY in the skill store: their content lives in the
 * marketplace clone, where `git pull` updates them in place, and uninstalling
 * the item removes the links (see uninstallItemLink's sweep). The link is
 * relative so it survives a branch data clone, and it goes through the ITEM
 * link, not into the clone directly, so a missed cleanup dangles harmlessly
 * (the skill disappears from listings) instead of keeping dead content alive.
 * The original copy design existed to protect local edits (Settings, the
 * reflective optimizer) from `git pull` — under the symlink model those skills
 * are read-only instead, and local mutability applies only to copied skills.
 *
 * Everything else keeps the COPY contract:
 *   - AGENTS, which remain locally mutable by design;
 *   - skills whose source is NOT an installed item — BOS's own seed/skills/ and
 *     a built-in method pack (spec-kit) whose root is in the SOURCE TREE, which
 *     no data/ symlink may point into: data/ is shared across versions and
 *     outlives any one worktree.
 *
 * A pre-symlink deployment migrates through the normal reconcile pass: an
 * installed COPY whose provenance hash still matches (untouched) is replaced by
 * the symlink; a locally-edited one is preserved and reported as a conflict,
 * exactly as an item update always was.
 *
 * Update safety for COPIED assets rides on a content hash recorded at install
 * time:
 *   - hash still matches what's on disk  -> untouched since install -> replace
 *   - hash differs                       -> the user (or an agent) changed it ->
 *                                           report a conflict, touch nothing
 *   - no recorded provenance             -> unknown -> treated as diverged, so a
 *                                           pre-existing copy is never clobbered
 *   - the user already declined this     -> asked and answered -> stay silent
 * The same shape as dpkg's conffile prompt: silent when safe, ask when not.
 *
 * Both of the non-obvious rules exist because "hash differs" has to mean THE
 * USER changed it, and nothing else:
 *
 *   - the hash EXCLUDES BOS's own bookkeeping in the same directory
 *     (`@/os/asset-bookkeeping`), and `restampInstalledAsset` re-records it when
 *     BOS deliberately rewrites an installed copy. Without those, BOS's own
 *     migration markers reported themselves as the user's edits, every boot;
 *   - a declined update is RECORDED, because a prompt the user cannot answer
 *     permanently is worse than no prompt at all.
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
  /** Why seeding could not finish, when it could not.
   *
   *  This function deliberately does not throw — an item's app and service facets
   *  are the primary deliverable and must install even if a bundled extra is
   *  unreadable. But an EMPTY result and a FAILED one looked identical to every
   *  caller: same `installed: []`, same `replaced: []`, no signal. A transient
   *  read failure therefore presented as "nothing needed doing", and the asset
   *  silently stayed at its old content.
   *
   *  Empty means it genuinely finished with nothing to do. */
  failures: string[];
}

interface Provenance {
  itemId: string;
  version?: string;
  /** Hash of what BOS last COPIED here, so a later change is detectable as the
   *  user's. Absent when BOS never copied this directory — a pre-existing
   *  asset whose only record is the `declined` decision below. */
  contentHash?: string;
  /** The user was asked about this asset and chose to keep their own copy.
   *
   *  Recorded because "keep" used to be a pure no-op: nothing on disk changed,
   *  so the very next reconciliation pass found the same divergence and asked
   *  again — every boot, forever, with no way to answer it permanently. Both
   *  hashes are stored so the question is re-asked exactly when it becomes a
   *  NEW one: the item shipped different content, or the user edited theirs
   *  again since deciding. */
  declined?: { sourceHash: string; localHash: string };
}

const destRootFor = (kind: BundledAssetKind, root?: string) => path.join(root ?? dataDir(), kind === "agent" ? "agents" : "skills");
const sourceRootFor = (itemPath: string, kind: BundledAssetKind) =>
  path.join(itemPath, kind === "agent" ? "agents" : "skills");

/**
 * Hash a whole asset directory, not just its entry file. A skill can carry
 * scripts/ and references/ alongside SKILL.md; hashing only the markdown would
 * call a skill "untouched" after its helper script was edited, and then
 * overwrite that edit on the next item update.
 *
 * Paths are included in the digest (so a rename is a change) and sorted (so the
 * digest doesn't depend on readdir order).
 *
 * BOS's OWN bookkeeping is excluded (`@/os/asset-bookkeeping`). The provenance
 * file has to be — it records this hash, so including it would be
 * self-referential — but the same is true of every seed-revision and migration
 * marker BOS writes into an asset directory after copying it. Counting those as
 * content is what reported an untouched installed agent as "edited since it was
 * installed" on every boot.
 */
async function hashDirectory(dir: string): Promise<string> {
  const files: string[] = [];
  const walk = async (current: string): Promise<void> => {
    // NEVER `.catch(() => [])`. A walk that silently skips an unreadable
    // directory returns the hash of FEWER FILES — and in the worst case the
    // digest of an empty list, which two different assets both produce. Every
    // decision in this module is "are these two hashes equal", so a degraded
    // hash does not fail loudly: it makes unequal things compare EQUAL, and the
    // seed then skips an update it should have applied or overwrites an edit it
    // should have preserved.
    //
    // Every caller has already established that `dir` exists (an lstat, a
    // readdir entry, or a copy it just made), so a failure here is real.
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (!isAssetBookkeeping(entry.name)) files.push(full);
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
    // Either record makes the file meaningful: `contentHash` says what BOS
    // installed, `declined` says the user already answered for what is here.
    return typeof parsed?.contentHash === "string" || parsed?.declined ? parsed : null;
  } catch {
    return null;
  }
}

async function writeProvenance(assetDir: string, provenance: Provenance): Promise<void> {
  await fs.writeFile(path.join(assetDir, PROVENANCE_FILE), JSON.stringify(provenance, null, 2) + "\n", "utf8");
}

/**
 * The relative target for a skill symlink: `../system/<itemId>/<relInsideItem>`.
 * From `data/skills/<id>` that resolves through the item link — for a bundled
 * skill `relInsideItem` is `skills/<id>`; for a skill-FACET item (SKILL.md at
 * the item root, superpowers-style) it is `""` and the target is the item link
 * itself.
 */
export function skillLinkTarget(itemId: string, relInsideItem: string): string {
  return path.join("..", "system", itemId, relInsideItem);
}

/** Replace whatever sits at destPath with a relative symlink. `fs.rm` does not
 *  follow symlinks, so an existing link is removed, never its target. */
async function linkAsset(destPath: string, target: string): Promise<void> {
  await fs.rm(destPath, { recursive: true, force: true });
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.symlink(target, destPath, "dir");
}

/**
 * True when `data/system/<itemId>` (in this root) resolves to `itemPath` — the
 * precondition for the symlink contract. False for a pack root that is not an
 * installed item (built-in spec-kit) and for a link that points at a DIFFERENT
 * source (two marketplaces offering the same id), where copy-mode's provenance
 * logic is the safe fallback.
 */
async function itemLinkResolvesTo(itemId: string, itemPath: string, root?: string): Promise<boolean> {
  try {
    const [linkReal, itemReal] = await Promise.all([
      fs.realpath(itemLinkPath(itemId, root)),
      fs.realpath(itemPath),
    ]);
    return linkReal === itemReal;
  } catch {
    return false;
  }
}

/**
 * Remove every `data/skills/` symlink that routes through this item's link —
 * the uninstall mirror of the seeding above. Judged on the LINK TEXT, not on
 * resolution: it must keep working when the target is already dangling (a
 * marketplace clone deleted out from under an installed item), which realpath
 * cannot resolve. Copied skills — including a locally-edited fork preserved as
 * a conflict — are real directories and are deliberately not touched: they are
 * the user's.
 */
export async function removeItemSkillLinks(itemId: string, root?: string): Promise<void> {
  const skillsRoot = destRootFor("skill", root);
  const prefix = path.join("..", "system", itemId);
  const entries = await fs.readdir(skillsRoot, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[]);
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    const linkPath = path.join(skillsRoot, entry.name);
    const target = await fs.readlink(linkPath).catch(() => null);
    if (target === null) continue;
    const normalised = path.normalize(target);
    if (normalised === prefix || normalised.startsWith(prefix + path.sep)) {
      await fs.rm(linkPath, { force: true });
    }
  }
}

/**
 * Link one skill-FACET item (SKILL.md at the item root, superpowers-style) into
 * the skill store: `data/skills/<itemId>` → `../system/<itemId>`. The bundled
 * variant (`<item>/skills/<id>/`) is handled by seedOneKind; this is the same
 * contract for the item shape that has no `skills/` directory.
 *
 * Refuses to replace a REAL directory of the same id: that is a local skill
 * (possibly a pre-symlink copy the user edited), and silently hijacking it is
 * exactly the clobbering the provenance model exists to prevent.
 */
export async function installSkillFacetLink(itemId: string, root?: string): Promise<void> {
  const destPath = path.join(destRootFor("skill", root), itemId);
  const destStat = await fs.lstat(destPath).catch(() => null);
  if (destStat && !destStat.isSymbolicLink()) {
    throw new Error(
      `A local skill "${itemId}" already exists in data/skills/ — archive or remove it before installing this item's skill.`,
    );
  }
  await linkAsset(destPath, skillLinkTarget(itemId, ""));
}

/** Copy one asset directory into place and stamp its provenance. */
async function copyAsset(sourcePath: string, destPath: string, itemId: string, version?: string): Promise<void> {
  await fs.rm(destPath, { recursive: true, force: true });
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.cp(sourcePath, destPath, { recursive: true });
  await writeProvenance(destPath, { itemId, version, contentHash: await hashDirectory(sourcePath) });
}

/**
 * Re-record the content hash of an installed asset that BOS ITSELF just
 * rewrote.
 *
 * The provenance hash answers one question — "has anyone changed this since BOS
 * put it here?" — and its whole value is that a `yes` means the USER. When BOS
 * edits an installed copy for its own reasons (a one-time migration that
 * backfills a tool allowlist, say), leaving the old hash in place makes BOS's
 * own write indistinguishable from the user's, and the next reconciliation pass
 * asks the user to arbitrate a change they never made.
 *
 * A no-op for anything BOS did not install: an asset with no provenance, or one
 * whose local copy the user has already claimed by declining an update, is not
 * ours to re-stamp.
 */
export async function restampInstalledAsset(assetDir: string): Promise<void> {
  const provenance = await readProvenance(assetDir);
  if (!provenance || typeof provenance.contentHash !== "string" || provenance.declined) return;
  await writeProvenance(assetDir, { ...provenance, contentHash: await hashDirectory(assetDir) });
}

/**
 * Apply the resolution the user chose for a conflict `seedItemBundledAssets`
 * reported.
 *
 * "keep" touches no asset content — the local copy already won by default, and
 * nothing was overwritten while the prompt was pending — but it is NOT a no-op.
 * It records the decision in the asset's provenance, because otherwise nothing
 * on disk distinguishes "the user kept theirs" from "nobody has been asked yet",
 * and the next reconciliation pass asks the identical question again.
 */
export async function resolveBundledAssetConflict(
  conflict: BundledAssetConflict,
  resolution: "keep" | "replace",
  version?: string,
): Promise<void> {
  if (resolution === "replace") {
    // "Replace" means "adopt the item's version" — which, for a skill of an
    // installed item, is the symlink contract, not a fresh copy. The local
    // edit being discarded here was the user's explicit choice.
    if (conflict.kind === "skill") {
      const itemPath = path.dirname(path.dirname(conflict.sourcePath));
      if (await itemLinkResolvesTo(conflict.itemId, itemPath)) {
        await linkAsset(conflict.destPath, skillLinkTarget(conflict.itemId, path.relative(itemPath, conflict.sourcePath)));
        return;
      }
    }
    await copyAsset(conflict.sourcePath, conflict.destPath, conflict.itemId, version);
    return;
  }

  const existing = await readProvenance(conflict.destPath);
  await writeProvenance(conflict.destPath, {
    ...(existing ?? {}),
    itemId: conflict.itemId,
    ...(version !== undefined ? { version } : {}),
    declined: {
      sourceHash: await hashDirectory(conflict.sourcePath),
      localHash: await hashDirectory(conflict.destPath),
    },
  });
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
  // ENOENT is the NORMAL case — most items bundle no agents and no skills — but
  // it is the only one. Any other failure means the source could not be READ,
  // and returning `[]` for that makes it indistinguishable from "this item
  // bundles nothing": the seed reports success having done nothing, the assets
  // never appear, and there is no error anywhere to explain it.
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(sourceRoot, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }

  // Skills of an INSTALLED item are symlinked through the item link; agents,
  // and skills of a non-installed pack root (built-in spec-kit), keep the
  // copy-with-provenance contract — see the module header.
  const linkMode = kind === "skill" && (await itemLinkResolvesTo(itemId, itemPath, root));

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const sourcePath = path.join(sourceRoot, id);
    const destPath = path.join(destRootFor(kind, root), id);
    const target = skillLinkTarget(itemId, path.join("skills", id));

    const destStat = await fs.lstat(destPath).catch(() => null);

    if (destStat?.isSymbolicLink()) {
      // Symlinks are the ITEM install's representation — they carry no
      // provenance file (it would sit inside the marketplace clone), so they
      // must be recognised BEFORE the hash/provenance logic below, which would
      // otherwise raise a bogus "unknown-provenance" conflict on every
      // reconcile pass, forever.
      if (!linkMode) continue; // owned by an item install; a copying seeder must not fight it
      const currentTarget = await fs.readlink(destPath).catch(() => null);
      if (currentTarget === target) continue;
      // A different link text that still resolves to this item's skill (e.g.
      // an absolute path from an older write) is normalised; a link into
      // anything else is not ours to rewrite.
      const [resolved, sourceReal] = await Promise.all([
        fs.realpath(destPath).catch(() => null),
        fs.realpath(sourcePath).catch(() => null),
      ]);
      if (resolved !== null && resolved === sourceReal) {
        await linkAsset(destPath, target);
        result.replaced.push({ kind, id });
      } else {
        result.conflicts.push({ kind, id, itemId, sourcePath, destPath, reason: "unknown-provenance" });
      }
      continue;
    }

    if (!destStat) {
      if (linkMode) await linkAsset(destPath, target);
      else await copyAsset(sourcePath, destPath, itemId, version);
      result.installed.push({ kind, id });
      continue;
    }

    const provenance = await readProvenance(destPath);
    const current = await hashDirectory(destPath);
    const incoming = await hashDirectory(sourcePath);

    // Already answered. Checked FIRST, and ahead of the provenance check, so it
    // also settles a conflict raised for unknown provenance — that case has no
    // recorded contentHash, and would otherwise be the one kind of conflict the
    // user could never stop being asked about.
    const declined = provenance?.declined;
    if (declined && declined.localHash === current && declined.sourceHash === incoming) continue;

    if (!provenance || typeof provenance.contentHash !== "string") {
      // A copy we didn't install, or one predating provenance tracking. Either
      // way we can't prove it's safe to overwrite, so we don't.
      result.conflicts.push({ kind, id, itemId, sourcePath, destPath, reason: "unknown-provenance" });
      continue;
    }

    if (current !== provenance.contentHash) {
      result.conflicts.push({ kind, id, itemId, sourcePath, destPath, reason: "diverged" });
      continue;
    }

    // Untouched since install. Replacing is safe. In link mode this is the
    // MIGRATION step for a pre-symlink deployment's copies — byte-identical
    // content still migrates, because the representation itself is what
    // changes; in copy mode a byte-identical incoming is skipped entirely, so
    // a reinstall of the same version doesn't churn mtimes.
    if (linkMode) {
      await linkAsset(destPath, target);
      result.replaced.push({ kind, id });
      continue;
    }
    if (incoming === current) continue;
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
  const result: SeedBundledAssetsResult = { installed: [], replaced: [], conflicts: [], failures: [] };
  try {
    await seedOneKind(itemPath, itemId, "agent", version, result, root);
    await seedOneKind(itemPath, itemId, "skill", version, result, root);
  } catch (err) {
    // Best-effort: keep whatever was seeded before the failure — but SAY so, in
    // the RESULT and not only in the log. A log line is not observable by the
    // caller, and "broken seed" was indistinguishable from "bundles nothing".
    result.failures.push((err as Error).message);
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

// Memoized PER DATA ROOT, not per process. `dataDir()` is env-driven and BOS
// changes it at runtime — a feature-branch data clone and a per-user container
// each have their own data root — so a single process-wide promise meant the
// first root to be scanned was the only one ever reconciled: after switching to
// a branch clone, an installed item's bundled agents/skills would never appear
// there. Keying by root keeps the "one scan per root" guarantee that both
// stores rely on while making the memo follow the data dir.
const reconcilePasses = new Map<string, Promise<void>>();

async function reconcileOnce(): Promise<void> {
  const items = await listInstalledItems();
  for (const item of items) {
    if (item.broken) continue;
    // Per item, so one unreadable item does not stop the rest being reconciled
    // — but REPORTED. `seedItemBundledAssets` already handles its own expected
    // absences (an item that bundles nothing), so anything reaching here is a
    // real failure, and the symptom it produces is a bundled agent that never
    // appears with nothing in the log to say why.
    try {
      const r = await seedItemBundledAssets(item.itemPath, item.id);
      if (r.failures.length) {
        // seedItemBundledAssets contains its own failures by design; the pass
        // above it must still say which item could not be seeded, or a
        // reconcile that achieved nothing looks like one with nothing to do.
        logger().error(COMPONENT, "reconcile.item.incomplete", undefined, { itemId: item.id, failures: r.failures });
      }
    } catch (err) {
      logger().error(COMPONENT, "reconcile.item.failed", undefined, {
        itemId: item.id,
        itemPath: item.itemPath,
        error: (err as Error).message,
      });
    }
  }
}

/**
 * Copy any not-yet-installed bundled agents/skills from every installed item.
 * Memoized per DATA ROOT — both stores call it and only one scan runs per root.
 * Never throws: a failure here must not block reading agents/skills.
 */
export async function reconcileInstalledItemAssets(): Promise<void> {
  const root = dataDir();
  let pass = reconcilePasses.get(root);
  if (!pass) {
    pass = reconcileOnce().catch((err) => {
      logger().warn(COMPONENT, "reconcile.failed", { error: (err as Error).message });
    });
    reconcilePasses.set(root, pass);
  }
  return pass;
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
  try {
    await writePending(merged, root);
  } catch (err) {
    // The whole point of the queue is that a conflict raised with nobody
    // watching still reaches the user. Losing the write silently means the
    // decision is never offered and the item stays on a stale bundled asset.
    logger().error(COMPONENT, "pending.write.failed", undefined, {
      conflicts: conflicts.map((c) => `${c.kind}:${c.id}`),
      error: (err as Error).message,
    });
  }
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

/**
 * Seed ONLY the skills bundled with a method pack (046 T002 / FR-008b).
 *
 * A narrow, kind-scoped entry point over the same `seedOneKind` +
 * `recordPendingConflicts` machinery a real marketplace item goes through, so
 * a pack's skill reconciles by the identical provenance contract: replaced
 * when untouched, reported as a conflict when diverged.
 *
 * DELIBERATELY NOT `seedItemBundledAssets`. That seeds BOTH kinds, so it would
 * copy the pack's `agents/` into `data/agents/` — resurrecting exactly the
 * copies 046 T007 archives, and writing into a root that 045 FR-001b reserves
 * for BOS's own seed. Agents are DISCOVERED from the pack root in place;
 * skills are COPIED. That asymmetry is real and is documented as such.
 *
 * `sourceRoot` is the pack's own directory — `sourceRootFor` pluralises the
 * kind, so the pack must keep its skills under `skills/`, not `skill/`. A
 * singular directory makes this a SILENT no-op, because the readdir below
 * catches to `[]`.
 */
export async function seedPackBundledSkills(
  packPath: string,
  packId: string,
  version?: string,
  root?: string,
): Promise<SeedBundledAssetsResult> {
  const result: SeedBundledAssetsResult = { installed: [], replaced: [], conflicts: [], failures: [] };
  try {
    await seedOneKind(packPath, packId, "skill", version, result, root);
  } catch (err) {
    logger().warn(COMPONENT, "pack.skills.seed.failed", { packId, packPath, error: (err as Error).message });
  }
  if (result.conflicts.length) await recordPendingConflicts(result.conflicts, root);
  if (result.installed.length || result.replaced.length || result.conflicts.length) {
    logger().info(COMPONENT, "pack.skills.seeded", {
      packId,
      installed: result.installed.length,
      replaced: result.replaced.length,
      conflicts: result.conflicts.length,
    });
  }
  return result;
}
