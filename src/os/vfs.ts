import "server-only";
import { promises as fs, createReadStream, createWriteStream } from "fs";
import { Readable, PassThrough } from "stream";
import path from "path";
import { dataDir } from "./data-dir";
import { writeFileAtomic, tempPathFor } from "./atomic-write";
import type { VfsEntry } from "./types";
import type { FSBackend } from "./fs-types";
import { resolveMountPath, normalizeMountPrefix } from "./mount-table";

// Resolved per call, not cached at module load: dataDir()/BOS_CANONICAL_DATA are
// fixed for the lifetime of a real BOS process, but tests importing this module
// override them (e.g. useTestDataDir()) after import — a frozen constant here
// would silently ignore that override and fall through to the real data dir.
function vfsRoot(): string {
  return path.join(dataDir(), "vfs");
}
// A few VFS subtrees must survive a discarded PREVIEW data clone (live version
// control, specs/005-self-modification), so they are rooted in CANONICAL data
// rather than this version's per-process data dir. Chat conversations are the prime
// case: history written while viewing a preview must not vanish when that preview's
// clone is deleted on Stop. (Mirrors the canonical data root convention; outside
// the Supervisor BOS_CANONICAL_DATA is unset and this is a no-op.)
function canonicalVfsRoot(): string {
  return path.join(process.env.BOS_CANONICAL_DATA?.trim() || dataDir(), "vfs");
}
const CANONICAL_SUBPATHS = ["Documents/Chats"];

/** The fs root for a cleaned (leading-slash-stripped) POSIX path: canonical data for
 *  the cross-version subtrees above, otherwise this version's own VFS root. */
function rootForClean(clean: string): string {
  for (const sub of CANONICAL_SUBPATHS) {
    if (clean === sub || clean.startsWith(sub + "/")) return canonicalVfsRoot();
  }
  return vfsRoot();
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

// Register the system mounts (Specs/Docs/Templates) exactly once, before any
// VFS op touches them. Dynamic import keeps the low-level VFS free of a static
// dependency on the spec layer (and avoids an import cycle).
let systemMountsReady = false;
async function ensureSpecMount(): Promise<void> {
  if (systemMountsReady) return;
  systemMountsReady = true;
  try {
    const mod = await import("@/lib/specs/spec-mount");
    await mod.ensureSystemMounts();
  } catch {
    // If the spec layer fails to load, unmounted VFS behaviour still works;
    // /Specs, /Docs, /Templates then fall through to local stub dirs.
    systemMountsReady = false;
  }
}

let seeded = false;
async function ensureVfs(): Promise<void> {
  await ensureSpecMount();
  const root = vfsRoot();
  await fs.mkdir(root, { recursive: true });
  // Conversations live in canonical data (CANONICAL_SUBPATHS) so they survive a
  // discarded preview clone — make sure that directory exists even when this version
  // runs on a clone whose own copy we deliberately bypass.
  await fs.mkdir(path.join(canonicalVfsRoot(), "Documents", "Chats"), { recursive: true });
  if (seeded) return;
  seeded = true;
  for (const dir of ["Documents", "Pictures", "Desktop"]) {
    await fs.mkdir(path.join(root, dir), { recursive: true });
  }
  // Mount-point stubs: real directories so "Specs"/"Docs"/"Templates" appear
  // when listing "/" even though reads/writes under them route to the
  // registered backends (SpecFS / DocsFS / ReadonlyFS). /Specs itself is NOT a
  // mount (only /Specs/user-specs and /Specs/bos-system-specs are), so it needs
  // its own stub children too — otherwise listing /Specs falls through to this
  // plain (would-be-empty) directory instead of resolving into either mount.
  for (const dir of ["Specs", "Docs", "Templates", "Specs/user-specs", "Specs/bos-system-specs"]) {
    await fs.mkdir(path.join(root, dir), { recursive: true });
  }
  const welcome = path.join(root, "Documents", "welcome.txt");
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

/**
 * Stream a file's bytes without buffering the whole thing in memory — for large
 * files (e.g. a WebDAV mount service's GET). `FSBackend` has no streaming
 * surface (027-vfs-specfs never needed one; its stores are small text/config
 * files), so a mounted path (`/Specs`, `/Docs`, `/Templates`) falls back to a
 * buffered read wrapped in a one-shot stream — fine for those, which are never
 * huge. The common, large-file case (plain `/Documents`, etc., unmounted) gets
 * a real `fs.createReadStream`.
 */
export async function readStream(vfsPath: string): Promise<NodeJS.ReadableStream> {
  await ensureVfs();
  const m = findMount(normalizeVfsPath(vfsPath));
  if (m) return Readable.from(await m.backend.readBuffer(m.rel));
  return createReadStream(resolveSafe(vfsPath));
}

/**
 * A stream to write into, plus `done` — resolve/reject on ACTUAL persistence,
 * separate from the stream's own `finish` event. This matters: for the
 * unmounted case below, `stream`'s `finish` fires once the temp file is fully
 * written, which is BEFORE the atomic rename over the real target — a caller
 * that stopped at `finish` would report success before the write is actually
 * durable at `vfsPath`. Always await `done`, never just `stream`'s `finish`.
 */
export interface VfsWriteStream {
  stream: NodeJS.WritableStream;
  done: Promise<void>;
}

/**
 * Stream bytes INTO a file without buffering the whole thing in memory — for
 * large files (e.g. a WebDAV mount service's PUT). Same mount-fallback
 * reasoning as `readStream`: a mounted path buffers the incoming stream (fine,
 * those stores are never huge) then delegates to the backend's own `writeBuffer`
 * — still the single source of truth for how that backend persists a write.
 * The unmounted case keeps the SAME write-temp-then-rename discipline as
 * `writeFileAtomic`, just spread across a stream instead of one call.
 */
export async function writeStream(vfsPath: string): Promise<VfsWriteStream> {
  await ensureVfs();
  const m = findMount(normalizeVfsPath(vfsPath));
  if (m) {
    const chunks: Buffer[] = [];
    const pass = new PassThrough();
    pass.on("data", (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<void>((resolve, reject) => {
      pass.on("error", reject);
      pass.on("end", () => {
        m.backend.writeBuffer(m.rel, Buffer.concat(chunks)).then(resolve, reject);
      });
    });
    return { stream: pass, done };
  }

  const real = resolveSafe(vfsPath);
  await fs.mkdir(path.dirname(real), { recursive: true });
  const tmp = tempPathFor(real);
  const fileStream = createWriteStream(tmp);
  const done = new Promise<void>((resolve, reject) => {
    fileStream.on("error", (err) => {
      fs.rm(tmp, { force: true }).catch(() => {});
      reject(err);
    });
    fileStream.on("finish", () => {
      fs.rename(tmp, real).then(resolve, reject);
    });
  });
  return { stream: fileStream, done };
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
  if (real === vfsRoot()) throw new Error("Refusing to remove the VFS root");
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
