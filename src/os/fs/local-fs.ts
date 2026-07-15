import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { writeFileAtomic } from "../atomic-write";
import { jailResolve } from "../path-jail";
import type { FSBackend } from "../fs-types";
import type { VfsEntry } from "../types";

// A generic filesystem backend rooted at an absolute host directory, with a
// path-escape jail. This is the default mount backend and the reusable base for
// any directory-rooted store (SpecFS composes the same jail against a git repo).
//
// Callers pass paths RELATIVE to `root`. `resolve()` is load-bearing for
// security: it refuses any path that would climb out of the root.
export class LocalFS implements FSBackend {
  constructor(private readonly root: string) {}

  private resolve(relPath: string): string {
    return jailResolve(this.root, relPath);
  }

  async list(relPath: string): Promise<VfsEntry[]> {
    const real = this.resolve(relPath);
    const names = await fs.readdir(real);
    const entries = await Promise.all(
      names.map(async (name): Promise<VfsEntry> => {
        const st = await fs.stat(path.join(real, name));
        return {
          name,
          path: path.posix.join("/", relPath, name),
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

  async stat(relPath: string): Promise<VfsEntry> {
    const real = this.resolve(relPath);
    const st = await fs.stat(real);
    const norm = path.posix.normalize("/" + (relPath || "/"));
    return {
      name: path.posix.basename(norm) || "/",
      path: norm,
      type: st.isDirectory() ? "dir" : "file",
      size: st.size,
      modified: st.mtimeMs,
    };
  }

  async readText(relPath: string): Promise<string> {
    return fs.readFile(this.resolve(relPath), "utf8");
  }

  async readBuffer(relPath: string): Promise<Buffer> {
    return fs.readFile(this.resolve(relPath));
  }

  async writeText(relPath: string, content: string): Promise<void> {
    await writeFileAtomic(this.resolve(relPath), content);
  }

  async writeBuffer(relPath: string, data: Buffer): Promise<void> {
    await writeFileAtomic(this.resolve(relPath), data);
  }

  async mkdir(relPath: string): Promise<void> {
    await fs.mkdir(this.resolve(relPath), { recursive: true });
  }

  async remove(relPath: string): Promise<void> {
    const real = this.resolve(relPath);
    if (real === this.root) throw new Error("Refusing to remove the filesystem root");
    await fs.rm(real, { recursive: true, force: true });
  }

  async rename(fromRel: string, toRel: string): Promise<void> {
    const from = this.resolve(fromRel);
    const to = this.resolve(toRel);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.rename(from, to);
  }

  async exists(relPath: string): Promise<boolean> {
    try {
      await fs.stat(this.resolve(relPath));
      return true;
    } catch {
      return false;
    }
  }
}
