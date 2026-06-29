import "server-only";
import path from "node:path";
import { promises as fs } from "node:fs";
import { dataDir } from "@/os/data-dir";

// Durable map of conversation (threadId) → the feature branch its developer work
// lives on. This is what lets "improve the thing we worked on" continue on the
// SAME branch after a Stop dropped the preview (the branch survives; this remembers
// which one). It must live in CANONICAL data, not a preview's throwaway data clone,
// so it survives Stop/promote — the Supervisor passes BOS_CANONICAL_DATA to every
// version's process for exactly this; outside the Supervisor it falls back to the
// process's own data dir.
function mapFile(): string {
  const root = process.env.BOS_CANONICAL_DATA?.trim() || dataDir();
  return path.join(root, "devharness", "thread-branches.json");
}

async function readMap(): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await fs.readFile(mapFile(), "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export async function getThreadBranch(threadId: string): Promise<string | undefined> {
  if (!threadId) return undefined;
  const b = (await readMap())[threadId];
  return typeof b === "string" && b ? b : undefined;
}

export async function setThreadBranch(threadId: string, branch: string): Promise<void> {
  if (!threadId || !branch) return;
  const map = await readMap();
  if (map[threadId] === branch) return;
  map[threadId] = branch;
  const f = mapFile();
  await fs.mkdir(path.dirname(f), { recursive: true }).catch(() => {});
  await fs.writeFile(f, JSON.stringify(map, null, 2)).catch(() => {});
}
