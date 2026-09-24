// 051 T021/T022 — the ONE way a workflow changes (FR-019).
//
//   canvas  ──PATCH /api/workflows──┐
//                                   ├──> applyWorkflowEdit ──> validate ──> write
//   agent   ──methods_edit tool────┘
//
// This is 049's `lifecycle.ts` lesson applied before the divergence rather than
// after it. That module exists because the agent tools and the Build Studio
// context menus had drifted into two implementations of one operation, and its
// header says two paths to one outcome is the shape every defect in this
// subsystem has taken. There is one function here, and both callers are
// transports over it.
//
// OPERATIONS, NOT A WHOLE-DESCRIPTOR PUT
//
// A PUT cannot distinguish "the user removed a phase" from "the user is working
// off a copy they loaded five minutes ago and is about to clobber the agent's
// edit." An op says what was meant; `rev` says what it was meant against.
//
// WHAT CHANGED FROM THE DESIGN'S OP SET
//
//   - `setOverride` is GONE. Phase 3 was dropped: no pack declares an override
//     surface, and the overlay (048) already serves "change this pack's content"
//     at file granularity. An op nothing can produce is worse than no op.
//   - `movePhase` is ADDED. §3.1c established that `phases[]` IS the pipeline —
//     position, not edges, is what the canvas lays out by and what a user means
//     by the order of steps. Without a reorder op a fork can change everything
//     about a workflow except the one thing most people fork to change.
//   - `setOptional` is ADDED for the same reason: `optional` became a declared
//     field in this feature (`[Clarify]`, `[UI Design]`) and nothing could set it.

import "server-only";
import { logger } from "@/lib/logging/server-logger";
import { getMethod, methodPackRoot, registerMethod } from "./registry";
import { readUserWorkflow, writeUserWorkflow, type UserWorkflow } from "./user-workflows";
import { validateDescriptor, type ValidationProblem } from "./validate";
import type { GateImpact } from "./gate-impact";
import type { ArtifactSpec, MethodDescriptor, PhaseSpec } from "./types";

const COMPONENT = "specs.method.authoring";

export type WorkflowOp =
  /** A new phase, placed AFTER `after` (or last). Position is the pipeline. */
  | { op: "addPhase"; id: string; label?: string; after?: string; optional?: boolean }
  | { op: "removePhase"; id: string }
  /** Change the id, the label, or both. */
  | { op: "renamePhase"; id: string; to?: string; label?: string }
  /** Move it in the declared order. `after: null` means first. */
  | { op: "movePhase"; id: string; after: string | null }
  /** The GATE edges into this phase — the only enforced kind. */
  | { op: "setRequires"; id: string; requires: string[] }
  | { op: "setOptional"; id: string; optional: boolean }
  /** Which declared artifacts this phase generates. Does not create artifacts:
   *  naming one the workflow has never heard of is a refusal, because inventing
   *  it would guess at a scope and a file name. */
  | { op: "setArtifacts"; id: string; artifacts: string[] }
  /** The skills that PERFORM this phase (048 FR-028).
   *
   *  Its absence was a hole in the closed set: an agent could author a skill
   *  with the pack's own builder and then had no way to attach it, so a phase
   *  added to a fork stayed empty forever.
   *
   *  A skill that is not installed YET is allowed and WARNED, not refused —
   *  declaring the phase and then building its skill is the natural order when a
   *  builder is doing the work, and the inspector already flags a phase whose
   *  skill is missing. */
  | { op: "setSkills"; id: string; skills: string[] };

export type RefusalCode =
  /** Not the user's to edit — it belongs to a pack. The answer is to fork. */
  | "not-yours"
  /** The caller's `rev` is behind. Someone else wrote in between. */
  | "stale"
  /** The op names a phase that is not in this workflow. */
  | "no-such-phase"
  /** The op would produce a descriptor that does not validate. */
  | "invalid"
  /** The op cannot be carried out without guessing. */
  | "unsupported";

/**
 * A refusal is a NORMAL OUTCOME carrying its reason, not a fault.
 *
 * "This workflow belongs to a pack" is the system working: the pack is read-only
 * and forking is the route. Callers render `message` directly, so it is written
 * for the person who hit it and always says what to do instead.
 */
export class WorkflowEditRefused extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
    /** Populated for `invalid`, so the UI can point at each problem rather than
     *  print one concatenated sentence. */
    readonly problems: ValidationProblem[] = [],
  ) {
    super(message);
    this.name = "WorkflowEditRefused";
  }
}

export interface EditResult {
  workflow: UserWorkflow;
  /** What the edit did BEYOND what was asked — a gate dropped because its target
   *  went away, an artifact left without a producer. Never silent: these are
   *  consequences the user did not type, and the whole reason `removePhase` can
   *  succeed at all rather than refusing on the first dangling reference. */
  warnings: string[];
  /** Gate edges this op introduced. The only ENFORCED edge kind, and the only
   *  one that can change what a live unit reports. */
  addedGates: Array<{ from: string; to: string }>;
  /** What those gates would block, whenever there are any (T025).
   *
   *  Computed HERE rather than by the caller, so the warning cannot be skipped
   *  by taking the other route. The design puts it in front of the canvas's
   *  Apply button; an agent calling `methods_edit` would then never see it,
   *  which is precisely the two-paths-one-outcome shape this module exists to
   *  prevent. Absent when the op added no gates — the walk is not free. */
  gateImpact?: GateImpact;
  /** True when nothing was written — `dryRun`. */
  preview: boolean;
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Every `dependsOn` node in a rule tree, wherever it is nested.
 *
 *  Structural, like `graph.ts` and `validate.ts`: `dependsOn` can sit inside
 *  `all`, `any`, `not` or `set`, and a walk that only checks the top level
 *  silently misses those — which for a rename means leaving a reference to a
 *  phase id that no longer exists. */
function visitDependsOn(rules: unknown, fn: (node: { phase?: unknown }) => void): void {
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const rec = node as Record<string, unknown>;
    if (rec.kind === "dependsOn") fn(rec);
    for (const v of Object.values(rec)) visit(v);
  };
  visit(rules);
}

/** Rewrite every `dependsOn` naming `from` to name `to`, in place. A rename that
 *  left these behind produces a descriptor that throws for every unit —
 *  `evaluate.ts` resolves through them exactly as it does through gates. */
function renameDependsOn(rules: unknown, from: string, to: string): void {
  visitDependsOn(rules, (node) => {
    if (node.phase === from) node.phase = to;
  });
}

/** Phases whose RULES depend on `id`. Consulted before removing a phase: unlike
 *  a `requires` edge, a `dependsOn` sits inside the rule DSL and cannot be
 *  dropped without deciding what the surrounding clause then means. */
function ruleDependentsOf(descriptor: MethodDescriptor, id: string): string[] {
  return descriptor.phases
    .filter((p) => {
      if (p.id === id) return false;
      let found = false;
      visitDependsOn(p.rules, (node) => {
        if (node.phase === id) found = true;
      });
      return found;
    })
    .map((p) => p.id);
}

function phaseIndex(descriptor: MethodDescriptor, id: string): number {
  const i = descriptor.phases.findIndex((p) => p.id === id);
  if (i === -1) {
    throw new WorkflowEditRefused(
      "no-such-phase",
      `"${id}" is not a phase in this workflow. Its phases are: ${descriptor.phases.map((p) => p.id).join(", ")}.`,
    );
  }
  return i;
}

/** Apply one op to a descriptor. Pure: mutates the CLONE it is given and returns
 *  what it did beyond the literal instruction. */
function mutate(d: MethodDescriptor, op: WorkflowOp, warnings: string[], addedGates: EditResult["addedGates"]): void {
  switch (op.op) {
    case "addPhase": {
      if (d.phases.some((p) => p.id === op.id)) {
        throw new WorkflowEditRefused("invalid", `This workflow already has a phase called "${op.id}".`);
      }
      const phase: PhaseSpec = {
        id: op.id,
        label: op.label?.trim() || op.id,
        requires: [],
        // No rules, on purpose. A new phase reports nothing automatically and
        // `graph.ts` will list it as isolated with reason "no-rules" — which is
        // the truth, and better than a guessed `exists: <id>.md` rule that would
        // make it look observed when nothing produces that file.
        rules: [],
        ...(op.optional ? { optional: true } : {}),
      };
      const at = op.after ? phaseIndex(d, op.after) + 1 : d.phases.length;
      d.phases.splice(at, 0, phase);
      warnings.push(`"${phase.label}" declares no rules yet, so BOS cannot observe whether it is done — it will show as N/A until you give it one.`);
      return;
    }

    case "removePhase": {
      const i = phaseIndex(d, op.id);
      const dependents = ruleDependentsOf(d, op.id);
      if (dependents.length) {
        throw new WorkflowEditRefused(
          "unsupported",
          `Cannot remove "${op.id}": ${dependents.join(", ")} ${dependents.length === 1 ? "has a rule that depends" : "have rules that depend"} on it. ` +
            `Those rules sit inside conditions BOS cannot rewrite without deciding what the surrounding condition then means — edit them first, then remove the phase.`,
        );
      }
      d.phases.splice(i, 1);

      for (const p of d.phases) {
        if (p.requires.includes(op.id)) {
          p.requires = p.requires.filter((r) => r !== op.id);
          warnings.push(`"${p.label}" no longer waits for "${op.id}" — that gate went with it.`);
        }
      }
      for (const a of d.artifacts) {
        if (a.generates === op.id) {
          delete a.generates;
          warnings.push(`"${a.id}" no longer has a phase that produces it.`);
        }
      }
      return;
    }

    case "renamePhase": {
      const i = phaseIndex(d, op.id);
      const to = op.to?.trim();
      if (op.label !== undefined) d.phases[i].label = op.label.trim() || d.phases[i].id;
      if (!to || to === op.id) return;
      if (d.phases.some((p) => p.id === to)) {
        throw new WorkflowEditRefused("invalid", `This workflow already has a phase called "${to}".`);
      }

      d.phases[i].id = to;
      for (const p of d.phases) {
        p.requires = p.requires.map((r) => (r === op.id ? to : r));
        renameDependsOn(p.rules, op.id, to);
      }
      for (const a of d.artifacts) if (a.generates === op.id) a.generates = to;

      // The instructions PATH is the pack's own file name and is declared, not
      // derived from the id (PhaseSpec.instructions). Renaming the phase must not
      // move it: the overlay is keyed by that path, so rewriting it here would
      // orphan every edit the user had already made to this phase's prompt.
      return;
    }

    case "movePhase": {
      const i = phaseIndex(d, op.id);
      const [phase] = d.phases.splice(i, 1);
      const at = op.after === null ? 0 : phaseIndex(d, op.after) + 1;
      d.phases.splice(at, 0, phase);
      return;
    }

    case "setRequires": {
      const i = phaseIndex(d, op.id);
      const before = new Set(d.phases[i].requires);
      const after = [...new Set(op.requires)];
      for (const r of after) if (!d.phases.some((p) => p.id === r)) phaseIndex(d, r); // refuses, naming it
      d.phases[i].requires = after;
      for (const r of after) if (!before.has(r)) addedGates.push({ from: r, to: op.id });
      return;
    }

    case "setOptional": {
      const i = phaseIndex(d, op.id);
      if (op.optional) d.phases[i].optional = true;
      else delete d.phases[i].optional;
      return;
    }

    case "setSkills": {
      phaseIndex(d, op.id);
      const skills = [...new Set(op.skills)].filter(Boolean);
      if (skills.length) d.phases[phaseIndex(d, op.id)].skills = skills;
      else delete d.phases[phaseIndex(d, op.id)].skills;
      return;
    }

    case "setArtifacts": {
      phaseIndex(d, op.id);
      const wanted = new Set(op.artifacts);
      const known = new Map(d.artifacts.map((a) => [a.id, a] as const));
      for (const id of wanted) {
        if (!known.has(id)) {
          throw new WorkflowEditRefused(
            "unsupported",
            `"${id}" is not an artifact this workflow declares, and BOS will not invent one — it would have to guess the file's scope. ` +
              `Declared artifacts: ${[...known.keys()].join(", ") || "(none)"}.`,
          );
        }
      }
      for (const a of d.artifacts as ArtifactSpec[]) {
        if (wanted.has(a.id)) a.generates = op.id;
        else if (a.generates === op.id) {
          delete a.generates;
          warnings.push(`"${a.id}" no longer has a phase that produces it.`);
        }
      }
      return;
    }
  }
}

/** Is a skill present in `data/skills`? The copy the agent actually loads. */
async function skillInstalled(id: string): Promise<boolean> {
  const { promises: fsp } = await import("fs");
  const nodePath = await import("path");
  const { dataDir } = await import("@/os/data-dir");
  try {
    await fsp.stat(nodePath.join(dataDir(), "skills", id, "SKILL.md"));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    // Unreadable is not absent, and reporting it as "author it" would send
    // someone to write a skill that is already there.
    throw err;
  }
}

/**
 * Apply one operation to a workflow the user owns.
 *
 * `expectedRev` is the revision the caller last saw. A mismatch is refused rather
 * than merged: "the user and the agent both edited" otherwise resolves by whoever
 * wrote last, silently, which is the failure this subsystem keeps producing.
 *
 * `dryRun` runs everything except the write — same op, same validator, same
 * refusals — so the canvas can show consequences BEFORE applying without a second
 * code path deciding what would happen.
 */
export async function applyWorkflowEdit(
  id: string,
  op: WorkflowOp,
  expectedRev: number,
  opts: { dryRun?: boolean; root?: string } = {},
): Promise<EditResult> {
  const wf = await readUserWorkflow(id, opts.root);
  if (!wf) {
    const fromPack = getMethod(id);
    throw new WorkflowEditRefused(
      "not-yours",
      fromPack
        ? `"${fromPack.label}" comes from a pack and is read-only. Fork it to get a copy you can edit — the original keeps receiving the pack's updates.`
        : `There is no workflow called "${id}".`,
    );
  }

  if (wf.rev !== expectedRev) {
    throw new WorkflowEditRefused(
      "stale",
      `"${id}" has changed since you loaded it — you have revision ${expectedRev}, it is now at ${wf.rev}. ` +
        `Reload it and make the change again, so you can see what the other edit did first.`,
    );
  }

  const warnings: string[] = [];
  const addedGates: EditResult["addedGates"] = [];
  const next = clone(wf.descriptor);
  mutate(next, op, warnings, addedGates);

  // A phase may name a skill that is not installed yet — that is the natural
  // order when a builder is about to author it — but it must not pass silently:
  // an unbacked phase runs nothing, and the inspector's flag is only seen by
  // someone who opens that phase.
  if (op.op === "setSkills" && op.skills.length) {
    for (const skillId of op.skills) {
      if (!(await skillInstalled(skillId))) {
        warnings.push(
          `"${skillId}" is not installed, so "${op.id}" has nothing to run yet. ` +
            `Author it — this pack may ship a builder for exactly that — and it will resolve.`,
        );
      }
    }
  }

  const problems = validateDescriptor(next);
  if (problems.length) {
    throw new WorkflowEditRefused(
      "invalid",
      `That change would leave "${id}" structurally broken, so it was not applied:\n${problems.map((p) => `- ${p.message}`).join("\n")}`,
      problems,
    );
  }

  // Before the write, so a dry run and a real one report the SAME consequence —
  // the dry run's whole job is to be what happens.
  const gateImpact = addedGates.length
    ? await (await import("./gate-impact")).gateImpact(id, next, addedGates)
    : undefined;

  const updated: UserWorkflow = { ...wf, descriptor: next, rev: wf.rev + 1 };
  if (opts.dryRun) return { workflow: updated, warnings, addedGates, gateImpact, preview: true };

  await writeUserWorkflow(id, updated, opts.root);
  // Re-register so the running process sees the edit. Through the SAME gate a
  // pack goes through — a fork is not privileged for being local, and an edit
  // that validates here but fails registerMethod must surface now rather than at
  // the next boot.
  registerMethod(updated.descriptor, methodPackRoot(updated.from));
  logger().info(COMPONENT, "workflow edited", { id, op: op.op, rev: updated.rev, warnings: warnings.length });

  return { workflow: updated, warnings, addedGates, gateImpact, preview: false };
}
