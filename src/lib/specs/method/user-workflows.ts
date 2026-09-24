// 051 T007-T009 — workflows the USER owns.
//
// `data/workflows/<id>/workflow.json`, under `data/` because that is where
// per-user mutable state lives and because FR-005 requires surviving pack
// upgrade, uninstall and reinstall — all three of which rewrite or remove a pack.
//
// WHEN TO REACH FOR THIS RATHER THAN THE OVERLAY
//
// 048's pack overlay (`data/method-packs/<id>/`) already changes a pack's own
// content for you, everywhere that pack is used, and Phase 1b showed it handles
// prompts completely with no fork involved. The two are not competitors:
//
//   overlay  "our review prompt says this"        — changes the pack everywhere
//   fork     "BMAD-without-the-PRD, these repos"  — a NEW NAMED workflow, bound
//                                                    per store or project
//
// So a fork is for the second case and only the second. Anything that is really
// "I want this pack to behave differently" belongs in the overlay, which is
// cheaper and keeps receiving upstream improvements.

import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { logger } from "@/lib/logging/server-logger";
import { getMethod, registerMethod, methodPackRoot, MethodSchemaError } from "./registry";
import type { MethodDescriptor } from "./types";

const COMPONENT = "specs.method.user-workflows";
const FILE = "workflow.json";

export const userWorkflowsRoot = (root?: string) => path.join(root ?? dataDir(), "workflows");
const workflowDir = (id: string, root?: string) => path.join(userWorkflowsRoot(root), id);

/** One file with a DISCRIMINANT, not two file names every reader has to try in
 *  turn and then reconcile when both exist (design §3.2). */
export type UserWorkflow =
  | {
      kind: "fork";
      /** What it was copied from, and at what version. For drift REPORTING only
       *  (FR-008) — never for resolution. A fork owes nothing to its source; that
       *  is the whole difference between forking and overriding. */
      from: string;
      fromVersion: string;
      /** Complete and self-sufficient — yours, including any edits since. */
      descriptor: MethodDescriptor;
      /** The source EXACTLY as it was when forked, untouched afterwards.
       *
       *  Stored so "what did I change?" is COMPUTABLE — `diff(baseline,
       *  descriptor)` is precisely the user's own edits, separable from whatever
       *  the base already said. Without it the two are indistinguishable, and an
       *  upgrade ("re-fork from the pack's new version and re-apply my changes")
       *  has nothing to re-apply.
       *
       *  This is the delta, DERIVED on demand rather than authored up front —
       *  which is why 051 needs no patch format, no path selectors and no merge
       *  rules. The judgement an upgrade needs (the base renamed a phase; does my
       *  change still mean the same thing?) belongs to an agent, not to a merge
       *  engine that would answer it silently and mechanically. */
      baseline: MethodDescriptor;
      /** Bumped on every write, so an edit made against a stale copy is refused
       *  rather than silently winning (design §3.6b). */
      rev: number;
    }
;

function isSafeId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(id) && !id.includes("..");
}

export async function readUserWorkflow(id: string, root?: string): Promise<UserWorkflow | null> {
  try {
    const raw = await fs.readFile(path.join(workflowDir(id, root), FILE), "utf8");
    return JSON.parse(raw) as UserWorkflow;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    // A workflow that exists but cannot be read is NOT one that does not exist.
    // Reporting it as absent would make a corrupt file look like a deleted one.
    logger().error(COMPONENT, "could not read a user workflow", undefined, { id, error: (err as Error).message });
    throw err;
  }
}

export async function listUserWorkflowIds(root?: string): Promise<string[]> {
  const entries = await fs.readdir(userWorkflowsRoot(root), { withFileTypes: true }).catch((err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

/** The ONE writer. `authoring.ts` edits through this rather than composing its
 *  own path and JSON, so "where a user workflow lives" is stated once. */
export async function writeUserWorkflow(id: string, wf: UserWorkflow, root?: string): Promise<void> {
  const dir = workflowDir(id, root);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, FILE), JSON.stringify(wf, null, 2) + "\n", "utf8");
}
const write = writeUserWorkflow;

/**
 * Carry the source's OVERLAY into the fork.
 *
 * A fork is a snapshot of what the user was looking at, and what they were
 * looking at includes their own edits — a customised prompt is as much part of
 * "this workflow" as a phase is. Without this, forking silently reverted every
 * prompt to the pack's original: the descriptor was copied resolved, so
 * structural changes carried, while file-level ones did not. Half the
 * customisation survived and half vanished, with nothing said.
 *
 * COPIED, not chained. Resolving a fork's prompts through its source's overlay
 * would work too, and would be wrong: a fork owes nothing to its source, and a
 * later edit to the source's prompts must not reach into the snapshot.
 */
async function copyOverlay(sourceId: string, newId: string, root?: string): Promise<void> {
  const { packOverlayDir } = await import("./overlay");
  const from = packOverlayDir(sourceId, root);
  try {
    await fs.cp(from, packOverlayDir(newId, root), { recursive: true });
  } catch (err) {
    // ENOENT is the normal case by far — nothing has been customised on the
    // source. It is also the ONLY acceptable one: any other failure means the
    // customisations could not be COPIED, and returning quietly would drop them
    // from the fork. That is precisely the harm this function was added to
    // prevent, so it must not become the way it fails.
    //
    // No separate `access` pre-check: `access` with no mode tests EXISTENCE, so
    // an unreadable directory passed it and the real error surfaced from `cp`
    // anyway — two ways to fail, one of them checking the wrong thing.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(
      `Could not copy "${sourceId}"'s customizations from ${from}, so the fork would silently lose them: ${(err as Error).message}`,
    );
  }
  logger().info(COMPONENT, "carried the source's overlay into the fork", { from: sourceId, to: newId });
}

/**
 * Fork a workflow into one the user owns (FR-002).
 *
 * The RESOLVED descriptor is copied, not the pack's file: what the user forked
 * is what they were looking at, which may already include an override. Copying
 * the file instead would silently drop that.
 */
export async function forkWorkflow(sourceId: string, newId: string, label?: string, root?: string): Promise<UserWorkflow> {
  if (!isSafeId(newId)) throw new Error(`"${newId}" is not a valid workflow id — use lowercase letters, digits and dashes.`);
  const source = getMethod(sourceId);
  if (!source) throw new Error(`No workflow "${sourceId}" to fork.`);
  if (getMethod(newId)) throw new Error(`A workflow called "${newId}" already exists.`);
  if (await readUserWorkflow(newId, root)) throw new Error(`A workflow called "${newId}" already exists.`);

  const wf: UserWorkflow = {
    kind: "fork",
    from: sourceId,
    fromVersion: source.version,
    descriptor: { ...source, id: newId, label: label?.trim() || `${source.label} (fork)`, builtin: false },
    baseline: source,
    rev: 1,
  };
  await write(newId, wf, root);
  await copyOverlay(sourceId, newId, root);
  logger().info(COMPONENT, "workflow forked", { from: sourceId, to: newId, fromVersion: source.version });
  return wf;
}

/** Delete a user workflow. The SOURCE pack is untouched — a fork owns its copy,
 *  and deleting the copy is the whole operation. */
export async function deleteUserWorkflow(id: string, root?: string): Promise<void> {
  await fs.rm(workflowDir(id, root), { recursive: true, force: true });
  logger().info(COMPONENT, "user workflow deleted", { id });
}

/**
 * Register every user workflow, AFTER the packs (T009).
 *
 * After, because a fork's id must not shadow a pack's, and because an override
 * can only resolve once its base is registered.
 *
 * A bad one NAMES ITSELF and does not abort the rest. This is user-editable data
 * reaching a gate built for pack data (R1): one malformed file must not take
 * every other workflow — and therefore every store bound to one — down with it.
 */
export async function registerUserWorkflows(root?: string): Promise<{ registered: string[]; failed: Record<string, string> }> {
  const registered: string[] = [];
  const failed: Record<string, string> = {};

  for (const id of await listUserWorkflowIds(root)) {
    try {
      const wf = await readUserWorkflow(id, root);
      if (!wf) continue;

      if (getMethod(id)) {
        // 049 FR-004's rule: REPORTED, never resolved by order. A pack that later
        // takes this name must not silently replace the user's workflow, nor be
        // silently replaced by it.
        failed[id] = `A pack already provides a workflow called "${id}"; the user copy was not registered.`;
        logger().warn(COMPONENT, "user workflow collides with a pack", { id });
        continue;
      }
      // The SAME gate a pack goes through — schemaVersion, phases, sections,
      // storeRoot. A fork is not privileged for being local.
      registerMethod(wf.descriptor, methodPackRoot(wf.from));
      registered.push(id);
    } catch (err) {
      const why = err instanceof MethodSchemaError ? err.message : (err as Error).message;
      failed[id] = why;
      logger().error(COMPONENT, "a user workflow could not be registered", undefined, { id, error: why });
    }
  }

  if (registered.length || Object.keys(failed).length) {
    logger().info(COMPONENT, "user workflows registered", { registered, failed: Object.keys(failed) });
  }
  return { registered, failed };
}

/** What a fork changed, and whether its source has moved since (FR-008).
 *
 *  A NOTICE, never a merge. Under the fork model an upgrade is "re-fork from the
 *  pack's current version and re-apply my changes", and the only thing BOS owes
 *  the user is telling them there is something to re-fork FROM — otherwise a fork
 *  is a silent freeze, and the user believes they are current when they are two
 *  versions behind.
 *
 *  The re-application itself is an agent's job. It needs judgement BOS does not
 *  have: if the base renamed `prd` to `requirements`, does the user's change to
 *  `prd` still mean the same thing? A merge engine answers that mechanically and
 *  silently; an agent can answer it and say what it did. */
export interface ForkStatus {
  id: string;
  from: string;
  /** The version it was forked at. */
  fromVersion: string;
  /** What the source is NOW, or null when the source pack is no longer installed
   *  — which is fine for a fork and is reported rather than treated as an error. */
  currentVersion: string | null;
  behind: boolean;
  /** Phase ids the USER added, removed or renamed, by comparing the fork against
   *  the baseline it was taken from. This is the delta an upgrade re-applies. */
  changedPhases: { added: string[]; removed: string[] };
}

export async function forkStatus(id: string, root?: string): Promise<ForkStatus | null> {
  const wf = await readUserWorkflow(id, root);
  if (!wf || wf.kind !== "fork") return null;

  const source = getMethod(wf.from);
  const mine = new Set(wf.descriptor.phases.map((p) => p.id));
  // `baseline` and not the source's CURRENT phases: comparing against current
  // would report the base's own changes as if the user had made them.
  const was = new Set(wf.baseline.phases.map((p) => p.id));

  return {
    id,
    from: wf.from,
    fromVersion: wf.fromVersion,
    currentVersion: source?.version ?? null,
    behind: Boolean(source && source.version !== wf.fromVersion),
    changedPhases: {
      added: [...mine].filter((p) => !was.has(p)),
      removed: [...was].filter((p) => !mine.has(p)),
    },
  };
}
