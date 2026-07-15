import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { specsRoot } from "@/os/specs-dir";
import { dataDir } from "@/os/data-dir";
import { ensureRepo, commitAll } from "@/lib/gitfs/store";
import { STORE_MANIFEST, type StoreManifest } from "@/lib/specs/stores";

// Seed the built-in spec stores under BOS_SPECS_ROOT (018-external-spec-store).
// The system store is seeded from a tracked bundle shipped with BOS, then kept in
// sync ADDITIVELY (add missing specs on updates, never clobber local edits) — the
// same idempotency discipline as seeded agents/skills. The user store is created
// empty. Idempotent: safe to call on every startup.

const SEED_BUNDLE = path.join(process.cwd(), "seed", "spec-store");
const SYSTEM_STORE_ID = "bos-system-specs";
const USER_STORE_ID = "user-specs";

const SYSTEM_MANIFEST: StoreManifest = {
  label: "System specs",
  owner: "system",
  writable: true,
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
 *  never overwriting a file the user may have edited. Skips `.git`/the manifest. */
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
  if (!(await pathExists(path.join(dir, STORE_MANIFEST)))) await writeManifest(dir, SYSTEM_MANIFEST);
  await commitAll(dir, fresh ? "seed system spec store" : "sync system specs");
}

async function ensureUserStore(dir: string): Promise<void> {
  const fresh = !(await pathExists(path.join(dir, ".git")));
  await ensureRepo(dir);
  if (!(await pathExists(path.join(dir, STORE_MANIFEST)))) await writeManifest(dir, USER_MANIFEST);
  if (fresh) await commitAll(dir, "init user spec store");
}

// ---- Fixed-layout stores under dataDir() (027-vfs-specfs) -------------------
// The new convention-over-configuration layout. System specs are READ-ONLY and
// MIRRORED from the tracked bundle on every boot (N2) so a spec changed in a
// release reaches existing users; the user store is created empty (writable) and
// backs the Documents/Specs mount. Coexists with the legacy specsRoot() layout
// during the phased migration; Phase 3 removes the legacy path.

const FIXED_SYSTEM_DIR = () => path.join(dataDir(), "specs", "system");
const FIXED_USER_DIR = () => path.join(dataDir(), "specs", "user");

const SYSTEM_MANIFEST_RO: StoreManifest = {
  label: "System specs",
  owner: "system",
  writable: false, // Option B: system specs are source, edited via the Developer agent.
  requiresPromote: true,
};

/** Mirror `src` → `dst` (overwrite changed, prune removed). Skips `.git` and the
 *  store manifest so the store's identity/history are preserved. */
async function mirrorTree(src: string, dst: string): Promise<void> {
  const srcEntries = await fs.readdir(src, { withFileTypes: true }).catch(() => [] as import("fs").Dirent[]);
  const keep = new Set<string>();
  for (const e of srcEntries) {
    if (e.name === ".git" || e.name === STORE_MANIFEST) continue;
    keep.add(e.name);
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      await fs.mkdir(d, { recursive: true });
      await mirrorTree(s, d);
    } else {
      await fs.copyFile(s, d);
    }
  }
  // Prune destination entries no longer present in the source bundle.
  const dstEntries = await fs.readdir(dst, { withFileTypes: true }).catch(() => [] as import("fs").Dirent[]);
  for (const e of dstEntries) {
    if (e.name === ".git" || e.name === STORE_MANIFEST || keep.has(e.name)) continue;
    await fs.rm(path.join(dst, e.name), { recursive: true, force: true });
  }
}

async function mirrorSystemStoreFixed(dir: string): Promise<void> {
  const fresh = !(await pathExists(path.join(dir, ".git")));
  await ensureRepo(dir);
  if (await pathExists(SEED_BUNDLE)) await mirrorTree(SEED_BUNDLE, dir);
  await writeManifest(dir, SYSTEM_MANIFEST_RO); // read-only manifest, single source of truth
  await commitAll(dir, fresh ? "seed system spec store" : "mirror system specs");
}

async function ensureUserStoreFixed(dir: string): Promise<void> {
  const fresh = !(await pathExists(path.join(dir, ".git")));
  if (fresh) {
    // One-time migration: lift a legacy BOS_SPECS_ROOT/user-specs store into the
    // fixed location so pre-027 user specs are not stranded.
    const legacy = path.join(specsRoot(), USER_STORE_ID);
    if (await pathExists(legacy)) {
      await fs.mkdir(dir, { recursive: true });
      await copyMissing(legacy, dir);
    }
  }
  await ensureRepo(dir);
  if (!(await pathExists(path.join(dir, STORE_MANIFEST)))) await writeManifest(dir, USER_MANIFEST);
  await commitAll(dir, fresh ? "init user spec store" : "sync user spec store");
}

/** Idempotently ensure the built-in system + user spec stores exist. Preview
 *  servers run with BOS_SPECS_SEED=0 (020): their spec root is a set of store
 *  WORKTREES on a feature branch, and a seed commit there would pollute it —
 *  seeding is base's job against the canonical stores. */
export async function ensureStores(): Promise<void> {
  if (process.env.BOS_SPECS_SEED === "0") return;
  // Legacy layout (specsRoot) — retained until Phase 3 migrates discovery.
  const root = specsRoot();
  await fs.mkdir(root, { recursive: true });
  await ensureSystemStore(path.join(root, SYSTEM_STORE_ID));
  await ensureUserStore(path.join(root, USER_STORE_ID));
  // Fixed layout (dataDir/specs) — backs the Documents/Specs mount.
  await mirrorSystemStoreFixed(FIXED_SYSTEM_DIR());
  await ensureUserStoreFixed(FIXED_USER_DIR());
}

// Run the seed at most once per server process — cheap to await everywhere the
// stores are needed (spec-fs, the API) without repeating git work each call.
let ensured: Promise<void> | null = null;
export function ensureStoresOnce(): Promise<void> {
  if (!ensured) ensured = ensureStores().catch((e) => { ensured = null; throw e; });
  return ensured;
}
