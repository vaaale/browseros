import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { writeFileAtomic } from "@/os/atomic-write";
import { CAPABILITIES } from "@/lib/agent/capabilities-registry";

// Global tool-description overrides edited from Settings → Tools. A user can
// rewrite the LLM-facing description of any tool without editing source. Reads
// happen on every request (no in-memory cache) so edits take effect on the
// next model turn.
//
// File shape: { [toolId]: description-string }. Missing / empty entry = use the
// source description from CAPABILITIES.

const FILE = path.join(dataDir(), "tool-descriptions.json");

export type ToolDescriptionOverrides = Record<string, string>;

export async function readOverrides(): Promise<ToolDescriptionOverrides> {
  try {
    const parsed = JSON.parse(await fs.readFile(FILE, "utf8")) as unknown;
    if (parsed && typeof parsed === "object") {
      const out: ToolDescriptionOverrides = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string" && v.trim().length > 0) out[k] = v;
      }
      return out;
    }
  } catch {
    /* missing or invalid: treat as empty */
  }
  return {};
}

async function writeAll(overrides: ToolDescriptionOverrides): Promise<void> {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await writeFileAtomic(FILE, JSON.stringify(overrides, null, 2) + "\n");
}

/** Set (or clear when `description` is empty/undefined) the override for `id`. */
export async function setOverride(id: string, description: string | undefined): Promise<void> {
  const current = await readOverrides();
  if (description && description.trim().length > 0) {
    current[id] = description;
  } else {
    delete current[id];
  }
  await writeAll(current);
}

/** Source description for `id` from the registry (fallback when no override). */
export function sourceDescription(id: string): string {
  return CAPABILITIES.find((c) => c.id === id)?.description ?? "";
}

/** Resolve the effective description: the override when present, otherwise the
 *  source description from CAPABILITIES. Used to build tool schemas the LLM sees. */
export async function effectiveDescription(id: string): Promise<string> {
  const overrides = await readOverrides();
  return overrides[id] ?? sourceDescription(id);
}
