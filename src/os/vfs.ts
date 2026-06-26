import "server-only";
import { promises as fs } from "fs";
import path from "path";
import type { VfsEntry } from "./types";

const VFS_ROOT = path.join(process.cwd(), "data", "vfs");

/** Resolve a POSIX-style VFS path to a real fs path, refusing escapes. */
function resolveSafe(vfsPath: string): string {
  const clean = path.posix.normalize("/" + (vfsPath || "/")).replace(/^\/+/, "");
  const abs = path.resolve(VFS_ROOT, clean);
  if (abs !== VFS_ROOT && !abs.startsWith(VFS_ROOT + path.sep)) {
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
  if (seeded) return;
  seeded = true;
  for (const dir of ["Documents", "Pictures", "Desktop", "Apps"]) {
    await fs.mkdir(path.join(VFS_ROOT, dir), { recursive: true });
  }
  const welcome = path.join(VFS_ROOT, "Documents", "welcome.txt");
  if (!(await exists(welcome))) {
    await fs.writeFile(
      welcome,
      "Welcome to BrowserOS.\n\nThis is your virtual file system. The OS agent can read and write here too.\n",
      "utf8",
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
  await fs.mkdir(path.dirname(real), { recursive: true });
  await fs.writeFile(real, content, "utf8");
}

export async function writeBuffer(vfsPath: string, data: Buffer): Promise<void> {
  await ensureVfs();
  const real = resolveSafe(vfsPath);
  await fs.mkdir(path.dirname(real), { recursive: true });
  await fs.writeFile(real, data);
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
