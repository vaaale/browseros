// The pluggable filesystem-backend interface behind the VFS mount table
// (027-vfs-specfs). A backend receives paths RELATIVE to its mount root; the
// mount table (src/os/mount-table.ts) has already stripped the mount prefix.
// LocalFS is the default backend; SpecFS (Phase 2) mounts at Documents/Specs.
//
// The surface mirrors the public vfs.ts functions so a backend is a drop-in for
// any sub-path. Keep this a type-only module (no `server-only`) so it is safe to
// import from both server code and pure logic/tests.

import type { VfsEntry } from "./types";

export interface FSBackend {
  list(relPath: string): Promise<VfsEntry[]>;
  stat(relPath: string): Promise<VfsEntry>;
  readText(relPath: string): Promise<string>;
  readBuffer(relPath: string): Promise<Buffer>;
  writeText(relPath: string, content: string): Promise<void>;
  writeBuffer(relPath: string, data: Buffer): Promise<void>;
  mkdir(relPath: string): Promise<void>;
  remove(relPath: string): Promise<void>;
  rename(fromRel: string, toRel: string): Promise<void>;
  exists(relPath: string): Promise<boolean>;
}

export interface MountPoint {
  /** Canonical VFS prefix (leading "/", no trailing "/"), e.g. "/Documents/Specs". */
  vfsPrefix: string;
  backend: FSBackend;
}
