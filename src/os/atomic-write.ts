import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";

/** A unique temp path in the SAME directory as `filePath`, for a same-filesystem
 *  rename. Shared by `writeFileAtomic` and any other atomic-write helper (e.g.
 *  `vfs.ts`'s streaming write) so the naming convention lives in exactly one
 *  place. Unique per process+call so concurrent writers never collide. */
export function tempPathFor(filePath: string): string {
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
}

// Crash-safe write: write to a temp file in the SAME directory, flush to disk,
// then rename over the target (atomic on a single filesystem). This is the
// write discipline required by the hardlink clone backend
// (specs/006-data-isolation/spec.md §6) and good hygiene for every store.
export async function writeFileAtomic(filePath: string, data: string | Uint8Array): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = tempPathFor(filePath);
  try {
    const handle = await fs.open(tmp, "w");
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
