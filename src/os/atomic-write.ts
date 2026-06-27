import "server-only";
import { promises as fs } from "fs";
import path from "path";

// Crash-safe write: write to a temp file in the SAME directory, flush to disk,
// then rename over the target (atomic on a single filesystem). This is the
// write discipline required by the hardlink clone backend
// (spec/self-modification/datafs.md §6) and good hygiene for every store.
export async function writeFileAtomic(filePath: string, data: string | Uint8Array): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
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
