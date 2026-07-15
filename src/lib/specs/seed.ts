import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { specsRoot } from "@/os/specs-dir";
import { ensureRepo, commitAll } from "@/lib/gitfs/store";
import { STORE_MANIFEST, type StoreManifest } from "@/lib/specs/stores";

// Seed the built-in spec stores under specsRoot() (018-external-spec-store;
// relocated to <dataDir>/specs by 027). The system store is seeded ADDITIVELY
// from a tracked bundle (add missing specs on updates, never clobber in-flight
// edits) and is READ-ONLY at runtime (Option B: system specs are source, edited
// via the Developer agent). The user store is writable and backs the
// Documents/Specs mount. Idempotent: safe to call on every startup.
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
  writable: false, // Option B: read-only at runtime; edited as source via the Developer agent.
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

async function ensureSystemStore(dir: string): Promise<void> {
  const fresh = !(await pathExists(path.join(dir, ".git")));
  await ensureRepo(dir);
  if (await pathExists(SEED_BUNDLE)) await copyMissing(SEED_BUNDLE, dir);
  await writeManifest(dir, SYSTEM_MANIFEST); // read-only manifest (single source of truth)
  await commitAll(dir, fresh ? "seed system spec store" : "sync system specs");
}

async function ensureUserStore(dir: string): Promise<void> {
  const fresh = !(await pathExists(path.join(dir, ".git")));
  await ensureRepo(dir);
  if (!(await pathExists(path.join(dir, STORE_MANIFEST)))) await writeManifest(dir, USER_MANIFEST);
  if (fresh) await commitAll(dir, "init user spec store");
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
}

// Run the seed at most once per server process — cheap to await everywhere the
// stores are needed (spec-fs, the API) without repeating git work each call.
let ensured: Promise<void> | null = null;
export function ensureStoresOnce(): Promise<void> {
  if (!ensured) ensured = ensureStores().catch((e) => { ensured = null; throw e; });
  return ensured;
}
