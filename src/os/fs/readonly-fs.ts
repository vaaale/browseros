import "server-only";
import { LocalFS } from "./local-fs";
import type { FSBackend } from "../fs-types";
import type { VfsEntry } from "../types";

// A read-only FSBackend wrapping LocalFS: reads pass straight through, every
// write op refuses. Used for VFS mounts that expose BOS-owned reference
// material (e.g. a method pack's /Methods/<id>/templates) where agents must never be able to write.
export class ReadonlyFS implements FSBackend {
  private readonly inner: LocalFS;

  constructor(root: string) {
    this.inner = new LocalFS(root);
  }

  list(relPath: string): Promise<VfsEntry[]> {
    return this.inner.list(relPath);
  }
  stat(relPath: string): Promise<VfsEntry> {
    return this.inner.stat(relPath);
  }
  readText(relPath: string): Promise<string> {
    return this.inner.readText(relPath);
  }
  readBuffer(relPath: string): Promise<Buffer> {
    return this.inner.readBuffer(relPath);
  }
  exists(relPath: string): Promise<boolean> {
    return this.inner.exists(relPath);
  }

  async writeText(): Promise<void> {
    throw new Error("This filesystem is read-only");
  }
  async writeBuffer(): Promise<void> {
    throw new Error("This filesystem is read-only");
  }
  async mkdir(): Promise<void> {
    throw new Error("This filesystem is read-only");
  }
  async remove(): Promise<void> {
    throw new Error("This filesystem is read-only");
  }
  async rename(): Promise<void> {
    throw new Error("This filesystem is read-only");
  }
}
