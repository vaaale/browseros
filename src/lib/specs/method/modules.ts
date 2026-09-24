// 048 M3 / T011 — module selection (FR-006, FR-007).
//
// BMAD ships three independently-selectable bundles: BMM (the agile suite,
// selected by default, needs config), BMB (the builder) and CIS (five
// facilitators). A user installs BMM alone, or adds the others, and gets
// exactly the agents those modules contribute.
//
// SELECTION LIVES IN `itemConfigDir`, NOT in the descriptor and NOT in the
// overlay (ADR-4):
//   - the descriptor is PACK CONTENT, overwritten on every upgrade, so a
//     selection stored there would silently revert;
//   - the overlay is for user CONTENT, not settings — mixing them would mean
//     "discard my customisations" also resets which modules are installed.
// `itemConfigDir` is already "BOS-owned mutable config, seeded from the item's
// defaults at install" (`installed.ts:37`). That is exactly this.

import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { itemConfigDir } from "@/system/items/installed";
import { logger } from "@/lib/logging/server-logger";
import { normalizeModules, type MethodDescriptor, type ModuleSpec } from "./types";

const COMPONENT = "specs.method.modules";
const SELECTION_FILE = "modules.json";

function selectionPath(packId: string, root?: string): string {
  return path.join(itemConfigDir(packId, root), SELECTION_FILE);
}

/** Module ids selected at install. Falls back to the descriptor's own
 *  `default` flags, so a pack installed before this existed behaves as its
 *  author intended rather than as "nothing selected". */
export async function selectedModules(descriptor: MethodDescriptor, root?: string): Promise<string[]> {
  const declared = normalizeModules(descriptor.modules);
  if (declared.length === 0) return [];
  try {
    const raw = await fs.readFile(selectionPath(descriptor.id, root), "utf8");
    const parsed = JSON.parse(raw) as { modules?: unknown };
    if (Array.isArray(parsed.modules)) {
      const valid = new Set(declared.map((m) => m.id));
      // Drop ids the pack no longer declares: an upgrade may remove a module,
      // and carrying a stale id forward would register a root for a directory
      // that is gone.
      return parsed.modules.filter((m): m is string => typeof m === "string" && valid.has(m));
    }
  } catch {
    /* never selected, or unreadable — fall through to the defaults */
  }
  return declared.filter((m) => m.default).map((m) => m.id);
}

export interface ModuleSelection {
  /** What was actually recorded. */
  stored: string[];
  /** Ids the descriptor no longer declares. Dropped, and named. */
  dropped: string[];
}

/**
 * Record the selection. Ids the descriptor does not declare are DROPPED and
 * REPORTED — not refused.
 *
 * This threw until a pack removed a module and proved why it must not. BMAD
 * declared `bmb` and `cis` with agent directories it never shipped; removing the
 * declarations made every reinstall fail with "does not declare module(s): bmb,
 * cis", because the stored selection still named them. The user could not
 * reinstall, could not deselect them (the pack no longer offers them), and the
 * only way out was hand-editing `data/system/config/<pack>/modules.json` — a file
 * nothing surfaces.
 *
 * `selectedModules` above has always dropped stale ids on READ, for exactly this
 * reason, in a comment that says "an upgrade may remove a module". The write path
 * disagreeing with the read path is the whole bug: one of them was going to be
 * wrong, and the fatal one was.
 *
 * The refusal was guarding a real thing — "a typo would otherwise persist
 * silently and register nothing" — and the report is what that guard actually
 * needed. Silent was the problem, not permissive.
 */
export async function selectModules(descriptor: MethodDescriptor, ids: string[], root?: string): Promise<ModuleSelection> {
  const declared = new Set(normalizeModules(descriptor.modules).map((m) => m.id));
  const stored = ids.filter((id) => declared.has(id));
  const dropped = ids.filter((id) => !declared.has(id));

  if (dropped.length) {
    logger().warn(COMPONENT, "module selection named modules the pack no longer declares", {
      packId: descriptor.id,
      dropped,
      declared: [...declared],
      stored,
    });
  }

  const dir = itemConfigDir(descriptor.id, root);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(selectionPath(descriptor.id, root), JSON.stringify({ modules: stored }, null, 2) + "\n", "utf8");
  return { stored, dropped };
}

/** The selected modules, as specs — what the install path turns into roots. */
export async function activeModules(descriptor: MethodDescriptor, root?: string): Promise<ModuleSpec[]> {
  const selected = new Set(await selectedModules(descriptor, root));
  return normalizeModules(descriptor.modules).filter((m) => selected.has(m.id));
}

/** A module's agents directory, relative to the PACK root. */
export function moduleAgentsDir(module: ModuleSpec): string {
  return module.agentsDir ?? path.join("modules", module.id, "agents");
}
