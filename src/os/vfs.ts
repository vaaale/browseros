import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "./data-dir";
import { writeFileAtomic } from "./atomic-write";
import type { VfsEntry } from "./types";

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

async function exists(real: string): Promise<boolean> {
  try {
    await fs.stat(real);
    return true;
  } catch {
    return false;
  }
}

let seeded = false;
async function ensureVfs(): Promise<void> {
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
  const real = resolveSafe(vfsPath);
  const names = await fs.readdir(real);
  const entries = await Promise.all(
    names.map(async (name): Promise<VfsEntry> => {
      const childReal = path.join(real, name);
      const st = await fs.stat(childReal);
      return {
        name,
        path: path.posix.join(normalizeVfsPath(vfsPath), name),
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
  const real = resolveSafe(vfsPath);
  const st = await fs.stat(real);
  const norm = normalizeVfsPath(vfsPath);
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
  return fs.readFile(resolveSafe(vfsPath), "utf8");
}

export async function readBuffer(vfsPath: string): Promise<Buffer> {
  await ensureVfs();
  return fs.readFile(resolveSafe(vfsPath));
}

export async function writeText(vfsPath: string, content: string): Promise<void> {
  await ensureVfs();
  const real = resolveSafe(vfsPath);
  await writeFileAtomic(real, content);
}

export async function writeBuffer(vfsPath: string, data: Buffer): Promise<void> {
  await ensureVfs();
  const real = resolveSafe(vfsPath);
  await writeFileAtomic(real, data);
}

export async function mkdir(vfsPath: string): Promise<void> {
  await ensureVfs();
  await fs.mkdir(resolveSafe(vfsPath), { recursive: true });
}

export async function remove(vfsPath: string): Promise<void> {
  await ensureVfs();
  const real = resolveSafe(vfsPath);
  if (real === VFS_ROOT) throw new Error("Refusing to remove the VFS root");
  await fs.rm(real, { recursive: true, force: true });
}

export async function rename(fromPath: string, toPath: string): Promise<void> {
  await ensureVfs();
  const from = resolveSafe(fromPath);
  const to = resolveSafe(toPath);
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.rename(from, to);
}
