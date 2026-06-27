import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { writeFileAtomic } from "@/os/atomic-write";

// Per-skill usage telemetry, kept in a sidecar so it never pollutes SKILL.md.
// Drives the Curator's staleness decisions.
const FILE = path.join(dataDir(), "skills", ".usage.json");

export interface UsageRecord {
  useCount: number;
  patchCount: number;
  lastActivityAt: number;
}
type UsageMap = Record<string, UsageRecord>;

async function read(): Promise<UsageMap> {
  try {
    return JSON.parse(await fs.readFile(FILE, "utf8")) as UsageMap;
  } catch {
    return {};
  }
}

async function write(map: UsageMap): Promise<void> {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await writeFileAtomic(FILE, JSON.stringify(map, null, 2));
}

export async function touchSkill(id: string, kind: "use" | "patch" = "use"): Promise<void> {
  const map = await read();
  const r = map[id] ?? { useCount: 0, patchCount: 0, lastActivityAt: 0 };
  if (kind === "use") r.useCount += 1;
  else r.patchCount += 1;
  r.lastActivityAt = Date.now();
  map[id] = r;
  await write(map);
}

export async function allUsage(): Promise<UsageMap> {
  return read();
}
