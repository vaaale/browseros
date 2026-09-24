import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { specsRoot } from "@/os/specs-dir";
import { ensureRepo, commitAll } from "@/lib/gitfs/store";
import { STORE_MANIFEST, PROJECT_MANIFEST, type StoreManifest } from "@/lib/specs/stores";
import type { ProjectManifest } from "@/lib/specs/projects";

// Seed the built-in spec stores under specsRoot() (018-external-spec-store;
// relocated to <dataDir>/specs by 027). The system store is seeded ADDITIVELY
// from a tracked bundle (add missing specs on updates, never clobber in-flight
// edits). The `writable` manifest flag still governs the Build Studio pipeline
// UI (src/lib/specs/pipeline.ts + src/lib/dev/spec-fs.ts), but agent file_* tools
// no longer consult it — both stores are mounted writable in the VFS
// (/Specs/bos-system-specs, /Specs/user-specs) via the newer os/fs/spec-fs.ts
// backend, gated only by whether a feature branch is active. Idempotent: safe
// to call on every startup.
//
// Migration (027 Phase 3): specsRoot() moved from <cwd>/specs to <dataDir>/specs.
// On first boot in the new location we COPY legacy store content across
// (non-destructively — the legacy dir is left intact as a fallback).

const SEED_BUNDLE = path.join(process.cwd(), "seed", "spec-store");
const LEGACY_ROOT = path.join(process.cwd(), "specs");
const SYSTEM_STORE_ID = "bos-system-specs";
const USER_STORE_ID = "user-specs";
// Phase-2 fixed-layout artifacts that used the wrong ids; removed on migration.
const STRAY_IDS = ["user", "system"];

const SYSTEM_MANIFEST: StoreManifest = {
  label: "System specs",
  owner: "system",
  writable: false, // Governs the Build Studio pipeline UI only; agent file_* tools ignore this (see comment above).
  requiresPromote: true,
};
const USER_MANIFEST: StoreManifest = {
  label: "User specs",
  owner: "user",
  writable: true,
  requiresPromote: false,
};

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function writeManifest(dir: string, m: StoreManifest): Promise<void> {
  await fs.writeFile(path.join(dir, STORE_MANIFEST), JSON.stringify(m, null, 2) + "\n");
}

/** Copy entries from `src` into `dst` that don't already exist in `dst` — additive,
 *  never overwriting a file that may have been edited. Skips `.git`/the manifest. */
async function copyMissing(src: string, dst: string): Promise<void> {
  const entries = await fs.readdir(src, { withFileTypes: true }).catch(() => [] as import("fs").Dirent[]);
  for (const e of entries) {
    if (e.name === ".git" || e.name === STORE_MANIFEST) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      await fs.mkdir(d, { recursive: true });
      await copyMissing(s, d);
    } else if (!(await pathExists(d))) {
      await fs.copyFile(s, d);
    }
  }
}

async function hasRemote(dir: string): Promise<boolean> {
  try {
    const cfg = await fs.readFile(path.join(dir, ".git", "config"), "utf8");
    return cfg.includes("[remote ");
  } catch { return false; }
}

async function ensureSystemStore(dir: string): Promise<void> {
  const fresh = !(await pathExists(path.join(dir, ".git")));
  await ensureRepo(dir);
  // Skip seeding when the store was cloned from a real remote (wizard set up
  // bos-specs from a URL). The remote's content is authoritative; overlaying the
  // seed bundle would pollute it with local-only files.
  if (!await hasRemote(dir) && await pathExists(SEED_BUNDLE)) {
    await copyMissing(SEED_BUNDLE, dir);
  }
  await writeManifest(dir, SYSTEM_MANIFEST); // read-only manifest (single source of truth)
  await commitAll(dir, fresh ? "seed system spec store" : "sync system specs");
}

async function ensureUserStore(dir: string): Promise<void> {
  const fresh = !(await pathExists(path.join(dir, ".git")));
  await ensureRepo(dir);
  // Enforce this store's own identity (owner/writable/requiresPromote) on
  // every boot, not just when no manifest exists yet — a manifest file being
  // PRESENT here doesn't mean it's actually a user-specs manifest. E.g.
  // copying bos-system-specs' entire directory content into user-specs/ (to
  // get a working copy of its specs) brings its spec-store.json along too
  // (`owner: "system", writable: false`), which would otherwise permanently
  // mislabel this store as the read-only system store. Only a legitimately
  // customized `label` is worth preserving; the rest is this store's fixed
  // identity, same principle as the system store's "single source of truth"
  // manifest above.
  const existing = await fs
    .readFile(path.join(dir, STORE_MANIFEST), "utf8")
    .then((raw) => JSON.parse(raw) as Partial<StoreManifest>)
    .catch(() => ({} as Partial<StoreManifest>));
  const label = typeof existing.label === "string" && existing.label.trim() ? existing.label.trim() : USER_MANIFEST.label;
  // PRESERVE BY DEFAULT, enforce only the three fields that ARE this store's
  // identity. Everything else in the manifest is user data.
  //
  // This was an allowlist — `label`, then `label` and `method` — and the
  // allowlist shape is what keeps failing. 045 FR-008 added `method` here
  // because a method assigned through the picker "would survive exactly until
  // the next restart and then silently revert to spec-kit". 049 then made
  // `workflow` the field that SUPERSEDES `method` for exactly this binding
  // (`resolveMethod` reads `store.workflow ?? store.method`) and did not add it
  // here — so a store bound to a WORKFLOW, which is how 051's forks are bound,
  // reverted on the next boot with no message. The same bug, via the field that
  // replaced the one it was fixed for.
  //
  // Spreading `existing` first ends the pattern: a new binding field is
  // preserved because nobody has to remember to preserve it.
  await writeManifest(dir, {
    ...existing,
    label,
    owner: USER_MANIFEST.owner,
    writable: USER_MANIFEST.writable,
    requiresPromote: USER_MANIFEST.requiresPromote,
  });
  // Always commit — a pre-existing (non-fresh) repo may still have just received
  // migrated content, which must be committed by the seed rather than left for
  // the SpecFS startup sweep. commitAll no-ops when the tree is clean.
  await commitAll(dir, fresh ? "init user spec store" : "sync user spec store");
}

// Store-root entries that are never part of a Project (033) — sibling
// metadata to the feature tree, not specs themselves. Dotfiles/dirs (.git,
// .specify) are skipped separately below.
const STORE_ROOT_KEEP = new Set([STORE_MANIFEST, "overview.md", "discrepancies.md"]);

/** Does this store's METHOD define the store root's layout?
 *
 *  The 033 migration below assumes a store root holds feature folders and
 *  nothing else, so anything else found there must be pre-Project content to be
 *  rescued. That is true for spec-kit and BMAD, whose only section is `rel: ""`.
 *  It is false for OpenSpec, which declares `changes/` and `specs/` AT the store
 *  root — migrating those renames the user's two trees into `user/` and commits
 *  it, emptying the store on the boot after adoption (047 US1).
 *
 *  Read straight off disk rather than through methodFor(): this runs inside
 *  ensureStores(), which resolving a method would re-enter.
 *
 *  A DECLARED BUT UNREGISTERED method also returns true. Not knowing a store's
 *  layout is the strongest possible reason not to rearrange it — the migration
 *  is a destructive rename, and refusing to run costs nothing a later boot
 *  cannot do once the pack is installed. */
async function methodOwnsStoreRoot(dir: string): Promise<boolean> {
  let methodId: string | undefined;
  try {
    const raw = await fs.readFile(path.join(dir, STORE_MANIFEST), "utf8");
    const m = JSON.parse(raw) as { method?: unknown };
    methodId = typeof m.method === "string" && m.method.trim() ? m.method.trim() : undefined;
  } catch {
    return false; // no manifest, no binding — ordinary pre-Project content
  }
  if (!methodId) return false;
  const { getMethod } = await import("./method/registry");
  const descriptor = getMethod(methodId);
  if (!descriptor) return true; // bound to something we cannot interpret: do not touch
  return descriptor.sections.some((s) => s.rel !== "");
}

/** Coarse, one-time migration (033-project-layer): wrap every existing
 *  top-level entry of a store into ONE default Project, so pre-Project
 *  content (a flat NNN-feature layout, or even older un-numbered feature
 *  dirs) doesn't just disappear from discovery once the pipeline only looks
 *  for Projects at the top level. Idempotent — once everything is already
 *  under `projectId`, there's nothing left to move and this is a no-op. A
 *  finer-grained reorganization is explicitly deferred to later. */
async function migrateToDefaultProject(dir: string, projectId: string, projectLabel: string): Promise<boolean> {
  if (await methodOwnsStoreRoot(dir)) return false;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [] as import("fs").Dirent[]);
  // Already reorganized into one or more real Projects (any top-level dir
  // owning a project.json) — nothing left to migrate, regardless of what
  // they're named or how many there are. Without this check, a later manual
  // reorganization that renames/splits the default Project looks identical
  // to "never migrated" and gets silently re-wrapped into a fresh
  // `projectId` dir on the next server start.
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    if (await pathExists(path.join(dir, e.name, PROJECT_MANIFEST))) return false;
  }
  const toMove = entries
    .filter((e) => !e.name.startsWith(".") && !STORE_ROOT_KEEP.has(e.name) && e.name !== projectId)
    .map((e) => e.name);
  if (toMove.length === 0) return false;
  const projectDir = path.join(dir, projectId);
  await fs.mkdir(projectDir, { recursive: true });
  for (const name of toMove) {
    await fs.rename(path.join(dir, name), path.join(projectDir, name));
  }
  const manifest: ProjectManifest = { label: projectLabel };
  const manifestPath = path.join(projectDir, PROJECT_MANIFEST);
  if (!(await pathExists(manifestPath))) {
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  }
  return true;
}

/** NON-DESTRUCTIVE relocation of legacy <cwd>/specs/<id> content into the new
 *  root. Uses additive copyMissing (never clobbers a diverged file), so it is
 *  safe to run on every boot even if the destination store repo already exists —
 *  which is exactly the case a pre-created-but-empty store hit. The legacy
 *  directory is never modified or removed. */
async function migrateLegacyStore(root: string, id: string): Promise<void> {
  if (path.resolve(root) === path.resolve(LEGACY_ROOT)) return; // same location, nothing to do
  const src = path.join(LEGACY_ROOT, id);
  if (!(await pathExists(src))) return; // no legacy content
  const dst = path.join(root, id);
  await fs.mkdir(dst, { recursive: true });
  await copyMissing(src, dst);
}

/** Idempotently ensure the built-in system + user spec stores exist under
 *  specsRoot(). Preview servers run with BOS_SPECS_SEED=0 (020): their spec root
 *  is a set of store WORKTREES on a feature branch, and a seed commit there would
 *  pollute it — seeding is base's job against the canonical stores. */
export async function ensureStores(): Promise<void> {
  if (process.env.BOS_SPECS_SEED === "0") return;
  const root = specsRoot();
  await fs.mkdir(root, { recursive: true });
  // Remove Phase-2 fixed-layout artifacts (wrong ids) so discovery sees only the
  // canonical stores.
  for (const stray of STRAY_IDS) {
    await fs.rm(path.join(root, stray), { recursive: true, force: true }).catch(() => {});
  }
  // Non-destructive legacy → new-root content migration.
  await migrateLegacyStore(root, SYSTEM_STORE_ID);
  await migrateLegacyStore(root, USER_STORE_ID);
  // Seed / normalize both stores in place.
  await ensureSystemStore(path.join(root, SYSTEM_STORE_ID));
  await ensureUserStore(path.join(root, USER_STORE_ID));
  // Coarse Project-layer migration (033): wrap pre-existing content into one
  // default Project per store. A no-op once already migrated.
  const systemDir = path.join(root, SYSTEM_STORE_ID);
  const userDir = path.join(root, USER_STORE_ID);
  if (await migrateToDefaultProject(systemDir, "bos", "BOS")) {
    await commitAll(systemDir, "migrate specs under the default BOS project");
  }
  if (await migrateToDefaultProject(userDir, "user", "User")) {
    await commitAll(userDir, "migrate specs under the default User project");
  }
}

// Run the seed at most once per server process — cheap to await everywhere the
// stores are needed (spec-fs, the API) without repeating git work each call.
let ensured: Promise<void> | null = null;
export function ensureStoresOnce(): Promise<void> {
  if (!ensured) ensured = ensureStores().catch((e) => { ensured = null; throw e; });
  return ensured;
}
