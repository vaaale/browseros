import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "./data-dir";
import { writeFileAtomic } from "./atomic-write";
import type { VfsEntry } from "./types";
import type { FSBackend } from "./fs-types";
import { resolveMountPath, normalizeMountPrefix } from "./mount-table";

const VFS_ROOT = path.join(dataDir(), "vfs");
// A few VFS subtrees must survive a discarded PREVIEW data clone (live version
// control, specs/005-self-modification), so they are rooted in CANONICAL data
// rather than this version's per-process data dir. Chat conversations are the prime
// case: history written while viewing a preview must not vanish when that preview's
// clone is deleted on Stop. (Mirrors the canonical data root convention; outside
// the Supervisor BOS_CANONICAL_DATA is unset and this is a no-op.)
const CANONICAL_VFS_ROOT = path.join(process.env.BOS_CANONICAL_DATA?.trim() || dataDir(), "vfs");
const CANONICAL_SUBPATHS = ["Documents/Chats"];

/** The fs root for a cleaned (leading-slash-stripped) POSIX path: canonical data for
 *  the cross-version subtrees above, otherwise this version's own VFS root. */
function rootForClean(clean: string): string {
  for (const sub of CANONICAL_SUBPATHS) {
    if (clean === sub || clean.startsWith(sub + "/")) return CANONICAL_VFS_ROOT;
  }
  return VFS_ROOT;
}

/** Resolve a POSIX-style VFS path to a real fs path, refusing escapes. */
function resolveSafe(vfsPath: string): string {
  const clean = path.posix.normalize("/" + (vfsPath || "/")).replace(/^\/+/, "");
  const root = rootForClean(clean);
  const abs = path.resolve(root, clean);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error("Path escapes the VFS root");
  }
  return abs;
}

/** Normalize any input into a canonical POSIX VFS path beginning with "/". */
export function normalizeVfsPath(vfsPath: string): string {
  return path.posix.normalize("/" + (vfsPath || "/"));
}

// Mount table (027-vfs-specfs). A registered mount routes a VFS sub-tree to an
// FSBackend; unmounted paths fall through to the default local VFS behaviour
// below (identical to pre-027). Mounts are registered once at server startup.
const mounts: { vfsPrefix: string; backend: FSBackend }[] = [];

/** Route a VFS sub-tree to a backend. Idempotent per prefix (last wins). */
export function registerMount(vfsPrefix: string, backend: FSBackend): void {
  const prefix = normalizeMountPrefix(vfsPrefix);
  const existing = mounts.findIndex((m) => m.vfsPrefix === prefix);
  if (existing >= 0) mounts[existing] = { vfsPrefix: prefix, backend };
  else mounts.push({ vfsPrefix: prefix, backend });
}

/** Resolve a normalized VFS path to a mounted backend + backend-relative path. */
function findMount(norm: string): { backend: FSBackend; rel: string } | null {
  const res = resolveMountPath(norm, mounts.map((m) => m.vfsPrefix));
  if (!res) return null;
  const mount = mounts.find((m) => m.vfsPrefix === res.prefix);
  return mount ? { backend: mount.backend, rel: res.rel } : null;
}

/** The real filesystem path backing a VFS path (refusing escapes). Use when a
 *  subsystem must operate on VFS-backed files at the host level — e.g. run_command
 *  bind-mounting the VFS workspace into its sandbox. */
export function hostPath(vfsPath: string): string {
  return resolveSafe(vfsPath);
}

async function exists(real: string): Promise<boolean> {
  try {
    await fs.stat(real);
    return true;
  } catch {
    return false;
  }
}

// Register the SpecFS mount exactly once, before any VFS op touches
// /Documents/Specs. Dynamic import keeps the low-level VFS free of a static
// dependency on the spec layer (and avoids an import cycle).
let specMountReady = false;
async function ensureSpecMount(): Promise<void> {
  if (specMountReady) return;
  specMountReady = true;
  try {
    const mod = await import("@/lib/specs/spec-mount");
    mod.ensureSpecMount();
  } catch {
    // If the spec layer fails to load, unmounted VFS behaviour still works;
    // /Documents/Specs then falls through to the local stub dir.
    specMountReady = false;
  }
}

let seeded = false;
async function ensureVfs(): Promise<void> {
  await ensureSpecMount();
  await fs.mkdir(VFS_ROOT, { recursive: true });
  // Conversations live in canonical data (CANONICAL_SUBPATHS) so they survive a
  // discarded preview clone — make sure that directory exists even when this version
  // runs on a clone whose own copy we deliberately bypass.
  await fs.mkdir(path.join(CANONICAL_VFS_ROOT, "Documents", "Chats"), { recursive: true });
  if (seeded) return;
  seeded = true;
  for (const dir of ["Documents", "Pictures", "Desktop", "Apps"]) {
    await fs.mkdir(path.join(VFS_ROOT, dir), { recursive: true });
  }
  // Mount-point stub: a real directory so "Specs" appears when listing
  // /Documents even though reads/writes under it route to SpecFS (Phase 2).
  await fs.mkdir(path.join(VFS_ROOT, "Documents", "Specs"), { recursive: true });
  const welcome = path.join(VFS_ROOT, "Documents", "welcome.txt");
  if (!(await exists(welcome))) {
    await writeFileAtomic(
      welcome,
      "Welcome to BrowserOS.\n\nThis is your virtual file system. The OS agent can read and write here too.\n",
    );
  }
}

export async function list(vfsPath: string): Promise<VfsEntry[]> {
  await ensureVfs();
  const norm = normalizeVfsPath(vfsPath);
  const m = findMount(norm);
  if (m) {
    const entries = await m.backend.list(m.rel);
    // Present canonical full VFS paths regardless of the backend's own rooting.
    return entries.map((e) => ({ ...e, path: path.posix.join(norm, e.name) }));
  }
  const real = resolveSafe(vfsPath);
  const names = await fs.readdir(real);
  const entries = await Promise.all(
    names.map(async (name): Promise<VfsEntry> => {
      const childReal = path.join(real, name);
      const st = await fs.stat(childReal);
      return {
        name,
        path: path.posix.join(norm, name),
        type: st.isDirectory() ? "dir" : "file",
        size: st.size,
        modified: st.mtimeMs,
      };
    }),
  );
  return entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
  );
}

export async function stat(vfsPath: string): Promise<VfsEntry> {
  await ensureVfs();
  const norm = normalizeVfsPath(vfsPath);
  const m = findMount(norm);
  if (m) return { ...(await m.backend.stat(m.rel)), path: norm };
  const real = resolveSafe(vfsPath);
  const st = await fs.stat(real);
  return {
    name: path.posix.basename(norm) || "/",
    path: norm,
    type: st.isDirectory() ? "dir" : "file",
    size: st.size,
    modified: st.mtimeMs,
  };
}

export async function readText(vfsPath: string): Promise<string> {
  await ensureVfs();
  const m = findMount(normalizeVfsPath(vfsPath));
  if (m) return m.backend.readText(m.rel);
  return fs.readFile(resolveSafe(vfsPath), "utf8");
}

export async function readBuffer(vfsPath: string): Promise<Buffer> {
  await ensureVfs();
  const m = findMount(normalizeVfsPath(vfsPath));
  if (m) return m.backend.readBuffer(m.rel);
  return fs.readFile(resolveSafe(vfsPath));
}

export async function writeText(vfsPath: string, content: string): Promise<void> {
  await ensureVfs();
  const m = findMount(normalizeVfsPath(vfsPath));
  if (m) return m.backend.writeText(m.rel, content);
  await writeFileAtomic(resolveSafe(vfsPath), content);
}

export async function writeBuffer(vfsPath: string, data: Buffer): Promise<void> {
  await ensureVfs();
  const m = findMount(normalizeVfsPath(vfsPath));
  if (m) return m.backend.writeBuffer(m.rel, data);
  await writeFileAtomic(resolveSafe(vfsPath), data);
}

export async function mkdir(vfsPath: string): Promise<void> {
  await ensureVfs();
  const m = findMount(normalizeVfsPath(vfsPath));
  if (m) return m.backend.mkdir(m.rel);
  await fs.mkdir(resolveSafe(vfsPath), { recursive: true });
}

export async function remove(vfsPath: string): Promise<void> {
  await ensureVfs();
  const m = findMount(normalizeVfsPath(vfsPath));
  if (m) return m.backend.remove(m.rel);
  const real = resolveSafe(vfsPath);
  if (real === VFS_ROOT) throw new Error("Refusing to remove the VFS root");
  await fs.rm(real, { recursive: true, force: true });
}

export async function rename(fromPath: string, toPath: string): Promise<void> {
  await ensureVfs();
  const fromNorm = normalizeVfsPath(fromPath);
  const toNorm = normalizeVfsPath(toPath);
  const mFrom = findMount(fromNorm);
  const mTo = findMount(toNorm);
  // A rename that crosses the mount boundary (or between two different mounts)
  // is not a simple fs.rename; refuse rather than silently corrupt.
  if (mFrom || mTo) {
    if (!mFrom || !mTo || mFrom.backend !== mTo.backend) {
      throw new Error("Cannot rename across a VFS mount boundary");
    }
    return mFrom.backend.rename(mFrom.rel, mTo.rel);
  }
  const from = resolveSafe(fromPath);
  const to = resolveSafe(toPath);
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.rename(from, to);
}
