// 051 FR-021…FR-024 — a phase's instructions: the prompt an agent runs for it.
//
// THE ONE WRITE PATH. The inspector and the agent both come here (FR-019) —
// every divergence in this subsystem has come from two paths to one outcome.
//
// Reads resolve OVERLAY FIRST, then the pack. Writes only ever go to the
// overlay, never to the pack, because a pack is an installed item that an
// upgrade replaces wholesale (FR-005). `data/method-packs/<id>/` already exists
// for exactly this and says so in its own header: "a WRITE DESTINATION FOR USER
// MODIFICATIONS TO ALREADY-INSTALLED CONTENT". 048 built it for agents; this
// extends it to templates, which is the same precedence rule over the same
// mirrored layout — not a second mechanism.

import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { getMethod, methodPackRoot } from "./registry";
import { packOverlayDir, ensureOverlay } from "./overlay";
import { logger } from "@/lib/logging/server-logger";

const COMPONENT = "specs.method.instructions";

export interface PhaseInstructions {
  /** The declared pack-relative path, or undefined when the pack declares none. */
  rel?: string;
  /** The prompt itself. Empty when nothing is written at either location. */
  text: string;
  /** Which copy won. `none` means the pack declared a path and no file is there —
   *  a real, reportable state, distinct from "declares nothing at all". */
  source: "overlay" | "pack" | "none";
  /** True when a user's version is in force, so the UI can offer Revert and can
   *  distinguish an edit from what shipped (FR-023). */
  edited: boolean;
  /** True when the pack declares no `instructions` for this phase at all. Three
   *  of spec-kit's twelve are in this state (FR-024). */
  undeclared: boolean;
}

function phaseOf(workflowId: string, phaseId: string) {
  const d = getMethod(workflowId);
  if (!d) throw new Error(`No workflow "${workflowId}".`);
  const phase = d.phases.find((p) => p.id === phaseId);
  if (!phase) throw new Error(`Workflow "${workflowId}" has no phase "${phaseId}".`);
  return phase;
}

/** A user's copy of a phase's instructions, at the SAME relative path inside the
 *  overlay. Mirroring the pack's layout is what lets one precedence rule walk
 *  both trees (048's own reasoning, applied here). */
function overlayPathFor(workflowId: string, rel: string): string {
  return path.join(packOverlayDir(workflowId), rel);
}

/** Where a phase's instructions live, for a pack that declares none.
 *
 *  It still needs somewhere to put them, or FR-024's "must still be writable"
 *  is unreachable. This is the only place BOS chooses a path rather than reading
 *  one — and it does so ONLY in the overlay, never in the pack, so it cannot
 *  collide with anything the pack ships or later adds. */
export function defaultInstructionsRel(phaseId: string): string {
  return path.join("instructions", `${phaseId}.md`);
}

async function readIfPresent(abs: string): Promise<string | null> {
  try {
    return await fs.readFile(abs, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    // A prompt that exists but cannot be read is NOT the same as one that does
    // not exist, and silently treating it as absent would show the user an empty
    // editor over a file they are about to overwrite.
    throw err;
  }
}

/** Resolve a phase's instructions: the user's copy if there is one, else the
 *  pack's, and say which. */
export async function readPhaseInstructions(workflowId: string, phaseId: string): Promise<PhaseInstructions> {
  const phase = phaseOf(workflowId, phaseId);
  const undeclared = !phase.instructions;
  const rel = phase.instructions ?? defaultInstructionsRel(phaseId);

  const mine = await readIfPresent(overlayPathFor(workflowId, rel));
  if (mine !== null) return { rel, text: mine, source: "overlay", edited: true, undeclared };

  // The pack's own copy — only when the pack actually declared a path. A pack
  // that declares none has nothing here by definition, and probing the invented
  // default inside the pack would be BOS guessing at its layout.
  if (!undeclared) {
    const root = methodPackRoot(workflowId);
    if (root) {
      const theirs = await readIfPresent(path.join(root, rel));
      if (theirs !== null) return { rel, text: theirs, source: "pack", edited: false, undeclared };
    }
  }
  return { rel, text: "", source: "none", edited: false, undeclared };
}

/**
 * Write a phase's instructions. ALWAYS to the overlay.
 *
 * There is no mode that writes into a pack. An edit there would be lost at the
 * next upgrade with no warning, which is the failure FR-005 exists to prevent
 * and the reason every BMAD `customize.toml` opens with `DO NOT EDIT`.
 */
export async function writePhaseInstructions(workflowId: string, phaseId: string, text: string): Promise<PhaseInstructions> {
  const phase = phaseOf(workflowId, phaseId);
  const rel = phase.instructions ?? defaultInstructionsRel(phaseId);
  await ensureOverlay(workflowId);
  const abs = overlayPathFor(workflowId, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text, "utf8");
  logger().info(COMPONENT, "phase instructions written to the overlay", { workflowId, phaseId, rel });
  return readPhaseInstructions(workflowId, phaseId);
}

/**
 * Drop the user's copy, putting the pack's own back in force (FR-023).
 *
 * Removing the overlay file is the whole operation — resolution falls through to
 * the pack on the next read. Nothing is "restored", because the pack's copy was
 * never touched.
 */
export async function revertPhaseInstructions(workflowId: string, phaseId: string): Promise<PhaseInstructions> {
  const phase = phaseOf(workflowId, phaseId);
  const rel = phase.instructions ?? defaultInstructionsRel(phaseId);
  await fs.rm(overlayPathFor(workflowId, rel), { force: true });
  logger().info(COMPONENT, "phase instructions reverted to the pack's", { workflowId, phaseId, rel });
  return readPhaseInstructions(workflowId, phaseId);
}
