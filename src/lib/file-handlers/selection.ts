import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { writeFileAtomic } from "@/os/atomic-write";
import { baseMime } from "@/os/file-handlers";

// 036-file-type-handlers: the ONLY durable state this feature introduces — the
// user's "always open <type> with <app>" choice, keyed by base MIME type. A
// small dedicated file under data/system/ (where per-feature runtime state
// already lives) rather than OSSettings: this is domain state, not something
// the user tunes in the Settings app. Branch isolation comes free via dataDir().
//
// A selection here is a *preference*, not a guarantee: whether it is honoured is
// decided at read time by registry.effectiveSelected(), which drops it if the
// app has since been uninstalled or lost its render capability (FR-011).

/** Base MIME type → app id. */
export type HandlerSelection = Record<string, string>;

function selectionFile(): string {
  return path.join(dataDir(), "system", "file-handlers.json");
}

/** The user's per-type selections; `{}` when nothing has been chosen yet. */
export async function readSelection(): Promise<HandlerSelection> {
  try {
    const parsed = JSON.parse(await fs.readFile(selectionFile(), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: HandlerSelection = {};
    for (const [mime, appId] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof appId === "string" && appId) out[baseMime(mime)] = appId;
    }
    return out;
  } catch {
    // Missing or malformed — no selections, fall back to manifest defaults.
    return {};
  }
}

/** Set the selected handler for a type, or clear it (`null`) to revert to the
 *  manifest default. `writeFileAtomic` creates data/system/ if it is missing. */
export async function writeSelection(mime: string, appId: string | null): Promise<void> {
  const key = baseMime(mime);
  const current = await readSelection();
  if (appId) current[key] = appId;
  else delete current[key];
  await writeFileAtomic(selectionFile(), JSON.stringify(current, null, 2) + "\n");
}
