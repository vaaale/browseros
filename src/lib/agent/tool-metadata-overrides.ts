import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { writeFileAtomic } from "@/os/atomic-write";
import { CAPABILITIES, type Capability } from "@/lib/agent/capabilities-registry";

// Persistent per-tool metadata overrides edited from Settings → Tools. A user
// can rewrite the LLM-facing description of any tool; the previous global
// `deferred` toggle has been removed (025 per-agent deferred lists live in
// each agent's AGENT.md instead). Only fields that DIFFER from the registry
// default are stored — omitted means "use registry default".
//
// File shape:
//   { [toolId]: { description?: string } }
//
// Migration:
//  - The older description-only file at data/tool-descriptions.json is folded
//    into this file on first read and then deleted.
//  - Any legacy `deferred` entries in an existing metadata-overrides.json are
//    silently dropped on read (they no longer round-trip through this store).

const FILE = path.join(dataDir(), "tool-metadata-overrides.json");
const OLD_DESC_FILE = path.join(dataDir(), "tool-descriptions.json");

export interface ToolMetadataOverride {
  description?: string;
}

export type ToolMetadataOverrides = Record<string, ToolMetadataOverride>;

function baseCapability(id: string): Capability | undefined {
  return CAPABILITIES.find((c) => c.id === id);
}

function baseDescription(id: string): string {
  return baseCapability(id)?.description ?? "";
}

function parseOverrides(raw: unknown): ToolMetadataOverrides {
  if (!raw || typeof raw !== "object") return {};
  const out: ToolMetadataOverrides = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const entry: ToolMetadataOverride = {};
    const desc = (v as Record<string, unknown>).description;
    if (typeof desc === "string" && desc.trim().length > 0) entry.description = desc;
    // Legacy `deferred` entries are intentionally ignored — per-agent
    // deferred lists live in AGENT.md now.
    if (entry.description !== undefined) out[id] = entry;
  }
  return out;
}

async function readOldDescriptions(): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await fs.readFile(OLD_DESC_FILE, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim().length > 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

// Merge old description-only overrides into the new file iff the new file
// doesn't yet exist. After migration the old file is removed.
async function migrateIfNeeded(): Promise<ToolMetadataOverrides | null> {
  try {
    await fs.access(FILE);
    return null; // new file exists — nothing to migrate
  } catch {
    /* new file missing — check old */
  }
  const old = await readOldDescriptions();
  if (Object.keys(old).length === 0) return null;
  const merged: ToolMetadataOverrides = {};
  for (const [id, desc] of Object.entries(old)) {
    if (baseCapability(id)) merged[id] = { description: desc };
  }
  await writeAll(merged);
  await fs.rm(OLD_DESC_FILE, { force: true }).catch(() => {});
  return merged;
}

async function writeAll(overrides: ToolMetadataOverrides): Promise<void> {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await writeFileAtomic(FILE, JSON.stringify(overrides, null, 2) + "\n");
}

/** Load the raw stored overrides. Migrates from tool-descriptions.json on first
 *  read if needed. Empty object when nothing is stored. */
export async function readMetadataOverrides(): Promise<ToolMetadataOverrides> {
  const migrated = await migrateIfNeeded();
  if (migrated) return migrated;
  try {
    return parseOverrides(JSON.parse(await fs.readFile(FILE, "utf8")));
  } catch {
    return {};
  }
}

/**
 * Persist a partial override for `id`.
 *   - `description === null`  ⇒ clear the description override (use registry)
 *   - `description === ""`    ⇒ same as null (empty ≡ reset)
 *   - `description` string    ⇒ store as override
 *   - omitted field           ⇒ leave existing value untouched
 * A field matching the registry default is dropped so the file only contains
 * true overrides. An entry with no remaining fields is removed entirely.
 */
export async function setMetadataOverride(
  id: string,
  patch: { description?: string | null },
): Promise<void> {
  if (!baseCapability(id)) throw new Error(`unknown tool: ${id}`);
  const current = await readMetadataOverrides();
  const entry: ToolMetadataOverride = { ...(current[id] ?? {}) };

  if ("description" in patch) {
    const d = patch.description;
    if (d === null || d === undefined || (typeof d === "string" && d.trim().length === 0)) {
      delete entry.description;
    } else {
      // Only store if it actually differs from the registry default.
      if (d === baseDescription(id)) delete entry.description;
      else entry.description = d;
    }
  }

  if (entry.description === undefined) {
    delete current[id];
  } else {
    current[id] = entry;
  }
  await writeAll(current);
}

/** Merged (registry + override) view of a capability. Description is always
 *  a non-empty string (falls back to registry). Deferred is always a boolean,
 *  sourced directly from the registry (no per-tool override any more). */
export interface EffectiveTool extends Capability {
  description: string;
  deferred: boolean;
}

/** Return the effective capability (registry default + persisted overrides). */
export async function getEffectiveTool(id: string): Promise<EffectiveTool | undefined> {
  const base = baseCapability(id);
  if (!base) return undefined;
  const overrides = await readMetadataOverrides();
  return mergeEffective(base, overrides[id]);
}

function mergeEffective(base: Capability, override: ToolMetadataOverride | undefined): EffectiveTool {
  const desc = override?.description ?? base.description;
  return { ...base, description: desc, deferred: base.deferred === true };
}

/** Effective view of every capability in the registry (sorted by registry order). */
export async function getEffectiveCatalog(): Promise<EffectiveTool[]> {
  const overrides = await readMetadataOverrides();
  return CAPABILITIES.map((c) => mergeEffective(c, overrides[c.id]));
}
