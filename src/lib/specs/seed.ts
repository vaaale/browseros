import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { specsRoot } from "@/os/specs-dir";
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

/** Idempotently ensure the built-in system + user spec stores exist. */
export async function ensureStores(): Promise<void> {
  const root = specsRoot();
  await fs.mkdir(root, { recursive: true });
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
