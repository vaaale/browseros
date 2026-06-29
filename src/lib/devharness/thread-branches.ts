import "server-only";
import path from "node:path";
import { promises as fs } from "node:fs";
import { dataDir } from "@/os/data-dir";

// Durable map of an opaque BRANCH KEY → the feature branch its developer work lives
// on. The key is any stable string the caller chooses to anchor repeated work to one
// feature branch: a chat's conversation id, a workflow id, an external `gitlab-issue:
// 1234`, etc. This is what lets "improve the thing we worked on" continue on the SAME
// branch after a Stop dropped the preview (the branch survives; this remembers which
// one). It must live in CANONICAL data, not a preview's throwaway data clone, so it
// survives Stop/promote — the Supervisor passes BOS_CANONICAL_DATA to every version's
// process for exactly this; outside the Supervisor it falls back to the process's own
// data dir. Keys share one flat namespace, so callers SHOULD prefix external ids
// (e.g. `gitlab-issue:1234`) to avoid colliding with chat ids (`c-…`).
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

export async function getBranchForKey(key: string): Promise<string | undefined> {
  if (!key) return undefined;
  const b = (await readMap())[key];
  return typeof b === "string" && b ? b : undefined;
}

export async function setBranchForKey(key: string, branch: string): Promise<void> {
  if (!key || !branch) return;
  const map = await readMap();
  if (map[key] === branch) return;
  map[key] = branch;
  const f = mapFile();
  await fs.mkdir(path.dirname(f), { recursive: true }).catch(() => {});
  await fs.writeFile(f, JSON.stringify(map, null, 2)).catch(() => {});
}
