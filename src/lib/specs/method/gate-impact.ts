// 051 T025 — what a new gate would BLOCK (R5).
//
// A `phases[].requires` edge is the only ENFORCED edge kind: an unsatisfied one
// makes the phase `blocked`. Adding one is allowed — it is the user's workflow —
// but it can flip live features en masse, and the canvas must say how many
// before applying it, not after.
//
// The hazard is measured, not hypothetical. `PhaseSpec.requires`' own doc
// comment records it: under the linear edges the phase order suggests,
// `converge requires implement` flips 120 of 132 live features from `na` to
// `blocked`, because `implement` is `done` on only 12. That is why spec-kit
// declares zero gates, and why a gate edit is the one authoring operation that
// warns.
//
// WHY NOT 045 FR-010's PREFLIGHT, WHICH THE TASK NAMED
//
// `preflightMethodChange` compares DISCOVERY — which units a descriptor can
// still find — and a gate changes no leaf marker, so it reports nothing at all.
// The question here is about phase STATE, which is a different computation and
// needs the evaluator. The two share the unit walk (`walkUnits`) and nothing
// else.

import "server-only";
import { listStores } from "@/lib/specs/stores";
import { listProjects } from "@/lib/specs/projects";
import { listDraftBranches } from "@/lib/specs/store-git";
import { methodForStore, evaluateUnitWith } from "@/lib/specs/pipeline";
import { logger } from "@/lib/logging/server-logger";
import { walkUnits } from "./preflight";
import type { MethodDescriptor } from "./types";

const COMPONENT = "specs.method.gate-impact";

export interface BlockedUnit {
  /** Store-prefixed path, e.g. "user-specs/build-studio/051-workflows". */
  unit: string;
  /** Phases that go from anything else to `blocked`. */
  phases: string[];
}

export interface GateImpact {
  workflowId: string;
  addedGates: Array<{ from: string; to: string }>;
  blocked: BlockedUnit[];
  /** How many units were actually evaluated.
   *
   *  Reported because "0 would be blocked" and "nothing is bound to this
   *  workflow, so nothing was checked" are the same number and completely
   *  different facts. A fork nobody has bound yet legitimately examines zero
   *  units, and presenting that as a clean bill of health is the kind of
   *  plausible-looking answer that gets trusted. */
  examined: number;
  /** Stores whose units were walked. */
  stores: string[];
  /** Units on draft `bos/*` branches, which were NOT evaluated.
   *
   *  Draft content has no base copy, so reading it means reading through git at
   *  a branch — a different path from the one `evaluateUnitWith` takes. Rather
   *  than quietly leaving them out of a count someone will act on, they are
   *  counted separately and named. */
  notExamined: { count: number; reason: string };
}

/** Gate edges present in `to` but not in `from`. */
export function addedGatesBetween(from: MethodDescriptor, to: MethodDescriptor): Array<{ from: string; to: string }> {
  const before = new Set(from.phases.flatMap((p) => (p.requires ?? []).map((r) => `${r}->${p.id}`)));
  const added: Array<{ from: string; to: string }> = [];
  for (const p of to.phases) {
    for (const r of p.requires ?? []) {
      if (!before.has(`${r}->${p.id}`)) added.push({ from: r, to: p.id });
    }
  }
  return added;
}

/** Every unit bound to this workflow, store-prefixed, plus how many draft-branch
 *  units were skipped. */
async function unitsBoundTo(workflowId: string): Promise<{ units: string[]; stores: string[]; drafts: number }> {
  const units: string[] = [];
  const stores: string[] = [];
  let drafts = 0;

  for (const store of await listStores()) {
    // An item-owned store IS one implicit unit with no feature subfolder, and it
    // resolves its method the same way. Walking it would find no leaves; it is
    // skipped here and would need its own handling if gates ever mattered to it.
    if (store.owner === "item") continue;

    const storeMethod = await methodForStore(store.id).catch((err: unknown) => {
      // A store bound to an uninstalled method cannot say what a unit even is.
      // It contributes nothing HERE, but it is a real condition and the reason
      // the count below may be smaller than the corpus — so it is logged rather
      // than dropped.
      logger().warn(COMPONENT, "a store's method could not be resolved, so it was not examined", {
        store: store.id, error: (err as Error).message,
      });
      return null;
    });
    if (!storeMethod) continue;

    let touched = false;
    const found = new Set<string>();
    for (const section of storeMethod.sections) {
      const roots = section.rel ? [section.rel] : (await listProjects(store.id)).map((p) => p.id);
      for (const root of roots) {
        // A Project may bind to a different workflow than its store (FR-008), so
        // the binding is resolved per root, not once per store. Resolving once
        // would either miss a Project that opted in or falsely include every
        // Project in a store that happens to be bound.
        const scoped = section.rel ? storeMethod : await methodForStore(store.id, root);
        if (scoped.id !== workflowId) continue;
        touched = true;
        await walkUnits(store.id, root, scoped, found);
      }
    }
    if (!touched) continue;

    stores.push(store.id);
    for (const u of found) units.push(`${store.id}/${u}`);
    drafts += (await listDraftBranches(store.root).catch((err: unknown) => {
      logger().warn(COMPONENT, "could not list draft branches", { store: store.id, error: (err as Error).message });
      return [] as string[];
    })).length;
  }

  return { units, stores, drafts };
}

/**
 * How many live units a descriptor change would newly BLOCK.
 *
 * Evaluates each unit twice — once under what is bound today, once under the
 * proposed descriptor — and reports the difference. There is no shortcut: a
 * phase's gates are consulted ONLY when no rule clause matched (`evaluate.ts`),
 * so "is phase X currently `pending`?" does not tell you whether adding a gate
 * to X changes anything. Deriving the answer from the current states alone
 * produces a number that is right most of the time, which is worse than one that
 * is right.
 *
 * `addedGates` is passed in rather than recomputed. `applyWorkflowEdit` already
 * knows exactly which edges its op introduced — deriving them again here from a
 * before/after diff would be a second answer to the same question, and the two
 * would disagree the first time an op added a gate in a way the diff missed.
 * `addedGatesBetween` exists for callers that only have the two descriptors.
 */
export async function gateImpact(
  workflowId: string,
  proposed: MethodDescriptor,
  addedGates: Array<{ from: string; to: string }>,
): Promise<GateImpact> {
  const { units, stores, drafts } = await unitsBoundTo(workflowId);

  const blocked: BlockedUnit[] = [];
  let examined = 0;

  for (const path of units) {
    const [storeId, ...rest] = path.split("/");
    const featureId = rest.join("/");
    const bound = await methodForStore(storeId);

    const [before, after] = await Promise.all([
      evaluateUnitWith(bound, storeId, featureId),
      evaluateUnitWith(proposed, storeId, featureId),
    ]);
    examined++;

    const was = new Map(before.map((p) => [p.id, p.state]));
    const phases = after.filter((p) => p.state === "blocked" && was.get(p.id) !== "blocked").map((p) => p.id);
    if (phases.length) blocked.push({ unit: path, phases });
  }

  const impact: GateImpact = {
    workflowId,
    addedGates,
    blocked,
    examined,
    stores,
    notExamined: {
      count: drafts,
      reason: drafts
        ? `${drafts} draft feature branch(es) were not evaluated — draft content is read through git at a branch, which this check does not do.`
        : "",
    },
  };
  logger().info(COMPONENT, "gate impact computed", {
    workflowId, examined, blocked: blocked.length, addedGates: addedGates.length,
  });
  return impact;
}

/** One sentence a person can act on. Never a bare count: "3 units would be
 *  blocked" out of how many, in which stores, is not enough to decide. */
export function describeGateImpact(i: GateImpact): string {
  if (!i.addedGates.length) return "";
  const gates = i.addedGates.map((g) => `${g.from} -> ${g.to}`).join(", ");

  if (i.examined === 0) {
    return `Adding ${gates}: no store or project is bound to "${i.workflowId}" yet, so nothing was checked. ` +
      `This has no effect today, and will apply to whatever you bind it to.`;
  }
  if (!i.blocked.length) {
    return `Adding ${gates} blocks nothing: all ${i.examined} unit(s) in ${i.stores.join(", ")} already satisfy it.`;
  }
  const lines = [
    `Adding ${gates} would BLOCK ${i.blocked.length} of ${i.examined} unit(s) in ${i.stores.join(", ")}.`,
    "They are not changed — the phase stops being reachable until what it now waits for is done.",
    "",
    ...i.blocked.slice(0, 20).map((b) => `  ${b.unit} — ${b.phases.join(", ")}`),
  ];
  // No silent truncation: a list that stops at 20 must say it stopped.
  if (i.blocked.length > 20) lines.push(`  … and ${i.blocked.length - 20} more`);
  if (i.notExamined.count) lines.push("", i.notExamined.reason);
  return lines.join("\n");
}
