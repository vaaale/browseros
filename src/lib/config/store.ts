import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { writeFileAtomic } from "@/os/atomic-write";

/** Resolved per call, NOT captured at module scope. `dataDir()` is env-driven
 *  (`BOS_DATA_DIR`) and BOS changes it at runtime — a feature-branch data clone
 *  and a per-user container both point it somewhere else — so a module-scope
 *  constant serves whatever path happened to be current the first time this
 *  module was imported. */
function dir(): string {
  return path.join(dataDir(), "config");
}

/** Generic per-namespace JSON config storage (data/config/<ns>.json). */
export async function readNamespace(ns: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir(), `${ns}.json`), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function writeNamespace(ns: string, values: Record<string, unknown>): Promise<void> {
  await writeFileAtomic(path.join(dir(), `${ns}.json`), JSON.stringify(values, null, 2));
}

export async function patchNamespace(ns: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  const next = { ...(await readNamespace(ns)), ...patch };
  await writeNamespace(ns, next);
  return next;
}

/**
 * The git committer identity BOS uses for commits it makes on the user's
 * behalf — tags, rebases, merges, and every repo BOS itself `git init`s (spec
 * stores, user-apps) — sourced from Settings → Versions (namespace
 * "self-modification"). Falls back to "BrowserOS" <bos@localhost> when unset,
 * so a fresh instance with no configured identity never hard-fails on
 * "Committer identity unknown". A leaf helper (this file only touches the
 * filesystem) so every git-writing module can depend on it without pulling in
 * the full config registry.
 */
export async function getGitIdentity(): Promise<{ name: string; email: string }> {
  const s = await readNamespace("self-modification");
  const name = typeof s.gitName === "string" && s.gitName.trim() ? s.gitName.trim() : "BrowserOS";
  const email = typeof s.gitEmail === "string" && s.gitEmail.trim() ? s.gitEmail.trim() : "bos@localhost";
  return { name, email };
}
