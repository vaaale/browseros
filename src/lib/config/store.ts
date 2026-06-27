import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { writeFileAtomic } from "@/os/atomic-write";

const DIR = path.join(dataDir(), "config");

/** Generic per-namespace JSON config storage (data/config/<ns>.json). */
export async function readNamespace(ns: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(path.join(DIR, `${ns}.json`), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function writeNamespace(ns: string, values: Record<string, unknown>): Promise<void> {
  await writeFileAtomic(path.join(DIR, `${ns}.json`), JSON.stringify(values, null, 2));
}

export async function patchNamespace(ns: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  const next = { ...(await readNamespace(ns)), ...patch };
  await writeNamespace(ns, next);
  return next;
}
