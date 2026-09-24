import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { specsRoot } from "@/os/specs-dir";
import { logger } from "@/lib/logging";
import { listItemStores } from "@/lib/specs/item-stores";
import type { StoreOwner } from "./types";

const COMPONENT = "specs.stores";

// Spec-store discovery (018-external-spec-store). Stores are discovered by
// LISTING the container root — there is NO central registry file (same rule as
// installed apps). A subdirectory is a store iff it has BOTH its own `.git` and a
// `spec-store.json` manifest. A store's role/policy come from its manifest, not
// its directory name, so a cloned marketplace repo brings its own identity.

// StoreOwner is the single source of truth in ./types.ts (framework-free, safe
// for client code too) — re-exported here so existing server-side imports of
// it from "./stores" keep working without a second, hand-synced declaration.
export type { StoreOwner };

export const STORE_MANIFEST = "spec-store.json";
/** Marks a directory-scanned store's top-level subfolder as a Project (033).
 *  Lives here (not projects.ts) so both stores.ts's consumers and
 *  dev/spec-fs.ts can import it without a projects.ts <-> spec-fs.ts cycle. */
export const PROJECT_MANIFEST = "project.json";

export interface StoreManifest {
  /** Human label shown as the Build Studio group name. */
  label: string;
  owner: StoreOwner;
  /** Whether spec-fs may write to this store at all. */
  writable: boolean;
  /** Retained as metadata (020): review happens on feature branches coupled to
   *  the code promote; writes commit-on-save regardless of this flag. */
  requiresPromote: boolean;
  /** 045 FR-008: the method (spec framework) this store is authored under.
   *  Absent ⇒ the user's global default ⇒ spec-kit, so an existing store that
   *  has never heard of method packs keeps behaving exactly as before. */
  method?: string;
  /** 049 FR-009: the WORKFLOW this store is bound to. Supersedes `method`,
   *  which keeps resolving as that method's default workflow. */
  workflow?: string;
  /** 050 FR-002: what this repository IS to BOS — which decides where a
   *  workflow may be bound and what a "project" means inside it (049 FR-011).
   *
   *  Recorded rather than inferred so it survives a restart and travels with
   *  the repository. ABSENT keeps today's behaviour exactly: a directory-scanned
   *  store is treated as `user-specs`, which is what every existing store is. */
  kind?: "system" | "user-specs" | "marketplace" | "arbitrary";
}

export interface SpecStore extends StoreManifest {
  /** Subdirectory name under the container root (the store id). */
  id: string;
  /** Absolute path to the store's content root — what spec-fs jails paths to. */
  root: string;
  /** Absolute path to the GIT REPO that versions this store's content. Equal to
   *  `root` for a directory-scanned store (which is its own repo root), but NOT
   *  for an item-owned store, whose root is `user-apps/items/<id>/spec` — a
   *  subdirectory of the shared `user-apps` repo. Anything addressing git by
   *  repo (history listing, `git show <ref>:<path>`, which resolves paths
   *  relative to the repo root) must use this, not `root`. */
  repoRoot: string;
  /** The store's path WITHIN its repo — `""` when the store IS its repo,
   *  `"specs"` / `"openspec"` for a registered repository, `items/<id>/spec` for
   *  an item store. Used to descend from a branch MOUNT (which is a worktree of
   *  the repo) back down to the store itself.
   *
   *  Recorded at discovery rather than derived later as
   *  `path.relative(repoRoot, root)` — which is wrong whenever a store is reached
   *  by SYMLINK, because `root` is then the link and `repoRoot` the real path, so
   *  the relative path between them walks out of the data dir and back
   *  (`../../specs/police-mcp`). Joined onto a mount at the same depth it
   *  cancelled out exactly and a spec write landed at the repository ROOT, with
   *  no error. Resolved once per scan, from the same realpath that finds the repo
   *  (design.md R1). */
  repoOffset: string;
  /** Set only for `owner: "item"` stores: "local" or the source
   *  marketplace's display name (item-stores.ts). */
  originLabel?: string;
  /** 046 FR-014: where this store's e2e tests live and run.
   *
   *  "repo"     — BOS's own checkout; the test file is `<testFile>` from the
   *               active descriptor, resolved and executed from cwd.
   *  undefined  — this store has NO test root. An item's content lives in
   *               data/user-apps/items/<id>/ and its tests are not BOS's to
   *               run: executing from cwd would run BOS's OWN suite and report
   *               the result as the item's, which is worse than refusing.
   *
   *  Two axes, deliberately separated: the test file's NAME comes from the
   *  method descriptor, its LOCATION is a property of the store KIND and so
   *  belongs here rather than in the descriptor. */
  testRoot?: "repo";
}

/** True when the entry is a directory, or a symlink that resolves to one. */
async function isDirectoryFollowingLinks(entry: import("fs").Dirent, abs: string): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  return fs.stat(abs).then((s) => s.isDirectory()).catch(() => false);
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/** How far above a store root its repo may be.
 *
 *  A method-declared store-root offset is one segment (`<repo>/openspec`), so
 *  one level covers every real case. The bound is the point: an UNBOUNDED walk
 *  attaches any unversioned directory to whatever repo happens to sit above it
 *  — under the data dir that is BOS's OWN checkout, which would then version a
 *  user's specs and accept git writes against it. A test caught exactly that.
 *
 *  Raise this only when a method declares a deeper offset, and make the
 *  declaration the reason rather than widening it speculatively. */
const MAX_REPO_WALK_UP = 1;

/** The git repo a store root belongs to: itself, or at most `MAX_REPO_WALK_UP`
 *  levels above. `null` when there is none within that bound.
 *
 *  ONE rule for two shapes (050 §3.2): a store that IS its own repo matches on
 *  the first step; an arbitrary project's `openspec/` folder finds the project
 *  one level up. Anything addressing git by repo — history,
 *  `git show <ref>:<path>` — needs this rather than the store root.
 *
 *  Resolved through the REAL path first, because a store is routinely a symlink
 *  into a repo kept outside the data dir; walking up from the link's own
 *  location would climb the wrong tree entirely. */
async function nearestRepoRoot(storeRoot: string): Promise<string | null> {
  let dir: string;
  try {
    dir = await fs.realpath(storeRoot);
  } catch {
    return null;
  }
  for (let up = 0; up <= MAX_REPO_WALK_UP; up++) {
    if (await isGitRepo(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

async function readManifest(dir: string): Promise<StoreManifest | null> {
  try {
    const raw = await fs.readFile(path.join(dir, STORE_MANIFEST), "utf8");
    const m = JSON.parse(raw) as Record<string, unknown> & Partial<StoreManifest>;
    const owner: StoreOwner =
      m.owner === "system" || m.owner === "user" || m.owner === "marketplace" ? m.owner : "marketplace";
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    // SPREAD, then narrow (045 FR-019). Reconstructing from named fields drops
    // every key this function has not heard of — and BOS REWRITES this file, so
    // a dropped key is deleted from the user's repository on the next write.
    // `method` had to be added here by hand for exactly that reason; `workflow`
    // and `kind` would have needed the same, and the one after them would have
    // been forgotten.
    return {
      ...m,
      label: typeof m.label === "string" ? m.label.trim() : "",
      owner,
      // Marketplaces default to read-only; system/user must opt in explicitly.
      writable: m.writable === true,
      requiresPromote: m.requiresPromote === true,
      ...(str(m.method) ? { method: str(m.method) } : {}),
      ...(str(m.workflow) ? { workflow: str(m.workflow) } : {}),
    };
  } catch (err) {
    // "No manifest" means "not a store" — the normal case for any other
    // directory under the specs root. A CORRUPT one is not: reporting it as
    // absent makes the store vanish from Build Studio, which reads as data loss
    // and hides the single file that explains it.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    if (err instanceof SyntaxError) {
      logger().error(COMPONENT, `${STORE_MANIFEST} is not valid JSON — this store will not appear`, undefined, {
        dir,
        error: err.message,
      });
      return null;
    }
    throw err;
  }
}

/** Discover the active spec stores under the container root, ordered
 *  system → user → marketplace → item, then by id. Missing root → no
 *  directory-scanned stores, but item-owned stores (installed items with a
 *  `spec/` facet — see item-stores.ts) are discovered independently and
 *  always merged in. */
export async function listStores(branch?: string): Promise<SpecStore[]> {
  const root = specsRoot();
  let entries: import("fs").Dirent[] = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const stores: SpecStore[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const dir = path.join(root, e.name);
    // A store may be a SYMLINK into the real repo rather than a directory in
    // this root — that is how a developer points BOS_SPECS_ROOT at stores kept
    // outside the data dir, and how the Supervisor can share one set of stores
    // across versions. `readdir(withFileTypes)` does NOT follow symlinks, so
    // `isDirectory()` is false for exactly those entries and they were skipped
    // silently: the store simply never appeared in Build Studio, with no error
    // anywhere. Resolve through `stat` (which follows) before deciding.
    if (!(await isDirectoryFollowingLinks(e, dir))) continue;
    // 050 T001: a store root may be a SUBDIRECTORY of its repo, not the repo
    // itself. An arbitrary project repo keeps its specs where the framework's
    // own CLI expects them (`<repo>/openspec`), so the store root is that
    // folder and the repo is its parent.
    //
    // Requiring isGitRepo(dir) skipped exactly those — silently, since a store
    // that never appears looks like one that was never added. Walking UP to the
    // nearest `.git` resolves all three cases with one rule: a store that IS
    // its own repo finds it on the first step, an item store finds the shared
    // user-apps repo, and a subdirectory store finds the project.
    const repoRoot = await nearestRepoRoot(dir);
    if (!repoRoot) continue;
    // From the REAL path, never from `dir` — which may be a symlink into a repo
    // kept outside the data dir. See `repoOffset`'s own doc comment.
    const repoOffset = path.relative(repoRoot, await fs.realpath(dir).catch(() => dir));
    const manifest = await readManifest(dir);
    if (!manifest) continue;
    // Directory-scanned stores (system/user/marketplace) test from BOS's own
    // checkout. Item stores are appended below WITHOUT a testRoot — see the
    // field's doc comment.
    stores.push({ id: e.name, root: dir, repoRoot, repoOffset, testRoot: "repo", ...manifest, label: manifest.label || e.name });
  }
  // `branch` widens ITEM discovery only: directory-scanned stores exist on base
  // whatever branch is active, while an app being CREATED exists only in the
  // branch's user-apps clone until it promotes. See listItemStores's own note.
  stores.push(...(await listItemStores(branch)));
  const rank = (o: StoreOwner) => (o === "system" ? 0 : o === "user" ? 1 : o === "marketplace" ? 2 : 3);
  return stores.sort((a, b) => rank(a.owner) - rank(b.owner) || a.id.localeCompare(b.id));
}

export async function getStore(id: string, branch?: string): Promise<SpecStore | undefined> {
  return (await listStores(branch)).find((s) => s.id === id);
}

/** The default target for NEW user specs: the writable user store, else any writable store. */
export async function defaultWritableStore(): Promise<SpecStore | undefined> {
  const stores = await listStores();
  return stores.find((s) => s.owner === "user" && s.writable) ?? stores.find((s) => s.writable);
}
