import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { writeFileAtomic } from "@/os/atomic-write";
import {
  CAPABILITIES,
  replaceDeferredOverrides,
  type Capability,
} from "@/lib/agent/capabilities-registry";

// Persistent per-tool metadata overrides edited from Settings → Tools. A user
// can (a) rewrite the LLM-facing description of any tool and (b) toggle whether
// a tool is `deferred` (hidden from the initial tool schema, discovered via
// find_tools at runtime). Only fields that DIFFER from the registry default are
// stored — omitted means "use registry default".
//
// File shape:
//   { [toolId]: { description?: string; deferred?: boolean } }
//
// Migration: an older description-only file at data/tool-descriptions.json is
// folded into this file on first read (its entries become { description }) and
// then deleted.

const FILE = path.join(dataDir(), "tool-metadata-overrides.json");
const OLD_DESC_FILE = path.join(dataDir(), "tool-descriptions.json");

export interface ToolMetadataOverride {
  description?: string;
  deferred?: boolean;
}

export type ToolMetadataOverrides = Record<string, ToolMetadataOverride>;

function baseCapability(id: string): Capability | undefined {
  return CAPABILITIES.find((c) => c.id === id);
}

function baseDeferred(id: string): boolean {
  return baseCapability(id)?.deferred === true;
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
    const def = (v as Record<string, unknown>).deferred;
    if (typeof desc === "string" && desc.trim().length > 0) entry.description = desc;
    if (typeof def === "boolean") entry.deferred = def;
    if (entry.description !== undefined || entry.deferred !== undefined) out[id] = entry;
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
 *   - `deferred === null`     ⇒ clear the deferred override (use registry)
 *   - `deferred` boolean      ⇒ store as override
 *   - omitted field           ⇒ leave existing value untouched
 * Fields that match the registry default are dropped so the file only contains
 * true overrides. An entry with no remaining fields is removed entirely.
 * After writing, the registry's mutable deferred-overrides table is refreshed
 * so subsequent isDeferred() calls in this process see the change immediately.
 */
export async function setMetadataOverride(
  id: string,
  patch: { description?: string | null; deferred?: boolean | null },
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

  if ("deferred" in patch) {
    const v = patch.deferred;
    if (v === null || v === undefined) {
      delete entry.deferred;
    } else if (v === baseDeferred(id)) {
      delete entry.deferred;
    } else {
      entry.deferred = v;
    }
  }

  if (entry.description === undefined && entry.deferred === undefined) {
    delete current[id];
  } else {
    current[id] = entry;
  }
  await writeAll(current);
  await refreshDeferredOverrides(current);
}

/** Merged (registry + override) view of a capability. Description is always
 *  a non-empty string (falls back to registry). Deferred is always a boolean. */
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
  const def = override?.deferred ?? base.deferred === true;
  return { ...base, description: desc, deferred: def };
}

/** Effective view of every capability in the registry (sorted by registry order). */
export async function getEffectiveCatalog(): Promise<EffectiveTool[]> {
  const overrides = await readMetadataOverrides();
  return CAPABILITIES.map((c) => mergeEffective(c, overrides[c.id]));
}

/** Push the current on-disk deferred overrides into the registry's mutable
 *  table. Call at server request boundaries so runtime code (`isDeferred`,
 *  `pickDeferredIds`, `find_tools`) reflects the latest edits without a restart. */
export async function reloadDeferredOverrides(): Promise<void> {
  await refreshDeferredOverrides(await readMetadataOverrides());
}

async function refreshDeferredOverrides(overrides: ToolMetadataOverrides): Promise<void> {
  const map: Record<string, boolean> = {};
  for (const [id, o] of Object.entries(overrides)) {
    if (typeof o.deferred === "boolean") map[id] = o.deferred;
  }
  replaceDeferredOverrides(map);
}
