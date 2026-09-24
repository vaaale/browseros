// 051 T004 — what the workflow canvas reads.
//
// Its own route rather than a field on /api/methods, because the two answer
// different questions: /api/methods says which methods exist and how to render a
// unit's phases; this says what a workflow's PIPELINE looks like.
//
// Everything here is computed SERVER-SIDE (constitution §2). The canvas is a
// client component and cannot reach `graph.ts`, and a second derivation in the
// browser is how the two would disagree about what a pack declares.

import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { readPhaseInstructions, writePhaseInstructions, revertPhaseInstructions } from "@/lib/specs/method/instructions";
import { listMethods, getMethod } from "@/lib/specs/method/registry";
import { ensureBuiltinMethod } from "@/lib/specs/method/resolve";
import { workflowGraph, type PhaseEdge, type IsolatedPhase } from "@/lib/specs/method/graph";
import { logger } from "@/lib/logging";

export const dynamic = "force-dynamic";

const COMPONENT = "api.workflows";

/** Which registered workflows are the user's own forks, and what from. */
async function ownedWorkflows(): Promise<Map<string, Owned>> {
  const { listUserWorkflowIds, readUserWorkflow } = await import("@/lib/specs/method/user-workflows");
  const out = new Map<string, Owned>();
  for (const id of await listUserWorkflowIds()) {
    const wf = await readUserWorkflow(id);
    // `rev` travels with the rest: every edit must state the revision it was
    // made against, so the canvas needs it at the moment it renders the thing
    // being edited. Fetching it separately when Save is pressed would read a
    // revision NEWER than what is on screen and defeat the check entirely.
    if (wf?.kind !== "fork") continue;
    // FR-008 — DRIFT, as a notice and never as a merge. Without it a fork is a
    // silent freeze: the user believes they are current when the source has
    // moved on twice. `null` when the source pack is no longer installed, which
    // is fine for a fork and is reported rather than treated as an error.
    const source = getMethod(wf.from);
    out.set(id, {
      from: wf.from,
      fromVersion: wf.fromVersion,
      rev: wf.rev,
      currentVersion: source?.version ?? null,
      behind: Boolean(source && source.version !== wf.fromVersion),
    });
  }
  return out;
}

/** A workflow the USER owns. Absent for a pack's own. */
export interface Owned {
  from: string;
  fromVersion: string;
  rev: number;
  /** What the source is NOW, or null when its pack is no longer installed. */
  currentVersion: string | null;
  behind: boolean;
}

export interface WorkflowSummary {
  id: string;
  label: string;
  version: string;
  builtin?: boolean;
  phases: number;
  /** Distinct connected pairs — what "N links" means in the UI. An edge RECORD
   *  is per (pair, kind), and one pair may be both a gate and a data flow, so
   *  the two counts differ and conflating them overstates the picture. */
  links: number;
  /** Enforced edges. Zero for spec-kit and BMAD; the distinction is the point. */
  gates: number;
  isolated: number;
  /** A workflow the USER owns, with what it was forked from and the revision it
   *  is at. Absent for a pack's own. Surfaced so the UI never offers "Fork" on
   *  something already forked, "Delete" on a pack it cannot delete, or an edit
   *  on something read-only. */
  owned?: Owned;
  /** Whether the pack declares anything customizable (FR-006). Absent surface ⇒
   *  fork is the only route, and the UI must say so rather than show an empty
   *  editor. Nothing declares one yet — the field is here so the list can state
   *  the fact rather than imply it. */
  customizable: boolean;
}

export interface WorkflowDetail extends WorkflowSummary {
  storeRoot: string;
  /** The skill that teaches an agent to RUN this pipeline.
   *
   *  Surfaced because it is the answer to "where are this pack's instructions?"
   *  for two of the three shipped packs. BMAD and OpenSpec declare NO per-phase
   *  prompts at all — their step knowledge is in the driver skill — so an
   *  inspector that only says "no prompt" describes a hole where there is a
   *  different shape. Naming the skill is reporting what the pack DECLARED, not
   *  inferring a mapping from it (FR-021). */
  driverSkill?: string;
  /** Skills this pack ships that AUTHOR new content (048 FR-029). Named so the
   *  inspector can point at them where authoring happens, rather than leaving a
   *  new phase empty with no route to filling it. BOS never runs them — they are
   *  skills, and the agent already has them. */
  builders: string[];
  /** How many phases BOS can say anything about — a declared prompt OR declared
   *  skills. A fact about the PACK, so it belongs where it is visible without
   *  clicking through every phase.
   *
   *  Counting `instructions` alone reported "0 of 10 prompts" for BMAD while
   *  every phase named a skill carrying one. */
  describedPhases: number;
  /** `order` is the phase's index in the pack's own `phases[]`, and it is what
   *  the canvas lays out by. NOT a dependency depth: the array declares a TOTAL
   *  ORDER, and deriving position from dependencies instead would scatter a
   *  pipeline whose steps are merely conventional — 9 of spec-kit's 11 are. */
  nodes: Array<{
    id: string; label: string; order: number; optional?: boolean;
    writes: string[]; reads: string[];
    /** Whether the PACK says anything about this step — a prompt file or a
     *  skill. The content itself is fetched per phase: sending twelve prompts,
     *  and now their skills, to render a strip would ship most of a pack on
     *  every open. */
    hasInstructions: boolean;
    /** The skills declared to perform it, by id. Named here so the canvas can
     *  show them without a second request per node. */
    skills: string[];
  }>;
  edges: PhaseEdge[];
  isolatedPhases: IsolatedPhase[];
  /** File references the derivation could not interpret. Surfaced rather than
   *  dropped: a sparser graph presented as fact is the failure mode (R6). */
  unreadable: string[];
}

/** Files a phase reads, recovered for display only. The canvas shows what the
 *  pack declared about a phase (FR-020); this is that, not an interpretation. */
function readsOf(edges: PhaseEdge[], phaseId: string): string[] {
  return [...new Set(edges.filter((e) => e.to === phaseId && e.via).map((e) => e.via as string))];
}

function summarize(id: string, owned?: Map<string, Owned>): WorkflowDetail | null {
  const d = getMethod(id);
  if (!d) return null;
  const g = workflowGraph(d);
  const links = new Set(g.edges.map((e) => `${e.from}->${e.to}`)).size;

  return {
    id: d.id,
    label: d.label,
    version: d.version,
    builtin: d.builtin,
    phases: d.phases.length,
    links,
    gates: g.edges.filter((e) => e.kind === "gate").length,
    isolated: g.isolated.length,
    ...(owned?.get(id) ? { owned: owned.get(id) } : {}),
    customizable: Array.isArray((d as { overrides?: unknown[] }).overrides) && ((d as { overrides?: unknown[] }).overrides?.length ?? 0) > 0,
    storeRoot: d.storeRoot,
    ...(d.driverSkill ? { driverSkill: d.driverSkill } : {}),
    builders: d.builders ?? [],
    describedPhases: d.phases.filter((p) => p.instructions || p.skills?.length).length,
    nodes: d.phases.map((p, i) => ({
      id: p.id,
      label: p.label,
      order: i,
      ...(p.optional ? { optional: true } : {}),
      writes: d.artifacts.filter((a) => a.generates === p.id).map((a) => a.id),
      reads: readsOf(g.edges, p.id),
      hasInstructions: Boolean(p.instructions) || Boolean(p.skills?.length),
      skills: p.skills ?? [],
    })),
    edges: g.edges,
    isolatedPhases: g.isolated,
    unreadable: g.unreadable,
  };
}

/** Edit a phase's instructions, or revert to the pack's.
 *
 *  The SAME functions the agent's tool calls (FR-019/FR-022) — this route is a
 *  transport over `instructions.ts`, never a second implementation of it. */
export async function PUT(req: NextRequest) {
  try {
    const { ensureInstalledMethodPacks } = await import("@/lib/specs/method/install");
    ensureBuiltinMethod();
    await ensureInstalledMethodPacks();

    const body = (await req.json()) as { id?: unknown; phase?: unknown; text?: unknown; revert?: unknown };
    const id = String(body.id ?? "");
    const phase = String(body.phase ?? "");
    if (!id || !phase) return NextResponse.json({ error: "id and phase are required" }, { status: 400 });

    const instructions = body.revert === true
      ? await revertPhaseInstructions(id, phase)
      : await writePhaseInstructions(id, phase, String(body.text ?? ""));
    return NextResponse.json({ instructions });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

/** Structural edits (051 T021) — the canvas's half of FR-019.
 *
 *  A TRANSPORT over `applyWorkflowEdit`, exactly as `methods_edit` is. It parses
 *  a request and renders a refusal; it decides nothing. Every rule about what an
 *  op may do lives in `authoring.ts`, so the two callers cannot drift.
 *
 *  Separate from PUT because they are different subjects: PUT edits a phase's
 *  PROMPT (a file, in the overlay, no fork needed), PATCH edits the workflow's
 *  STRUCTURE (the descriptor, fork only). Collapsing them would put "which of
 *  two unrelated things did you mean" into the body. */
export async function PATCH(req: NextRequest) {
  try {
    ensureBuiltinMethod();
    const { ensureInstalledMethodPacks } = await import("@/lib/specs/method/install");
    await ensureInstalledMethodPacks();
    const { registerUserWorkflows } = await import("@/lib/specs/method/user-workflows");
    await registerUserWorkflows();

    const body = (await req.json()) as { id?: unknown; rev?: unknown; op?: unknown; preview?: unknown };
    const id = String(body.id ?? "");
    if (!id || typeof body.op !== "object" || body.op === null) {
      return NextResponse.json({ error: "id and op are required" }, { status: 400 });
    }
    if (typeof body.rev !== "number") {
      // Not defaulted. A missing `rev` defaulted to the current one would make
      // every edit unconditionally win, which is the concurrent-overwrite this
      // field exists to prevent — and it would do so silently.
      return NextResponse.json({ error: "rev is required — send the revision you loaded." }, { status: 400 });
    }

    const { applyWorkflowEdit, WorkflowEditRefused } = await import("@/lib/specs/method/authoring");
    const { describeGateImpact } = await import("@/lib/specs/method/gate-impact");
    try {
      const r = await applyWorkflowEdit(
        id,
        body.op as import("@/lib/specs/method/authoring").WorkflowOp,
        body.rev,
        { dryRun: body.preview === true },
      );
      return NextResponse.json({
        workflow: summarize(id, await ownedWorkflows()),
        // A preview wrote nothing, so the caller's `rev` is still the current
        // one. Returning the would-be rev there would have the UI adopt a
        // revision that does not exist, and its next real edit would be refused
        // as stale — for a change it never made.
        rev: r.preview ? body.rev : r.workflow.rev,
        warnings: r.warnings,
        preview: r.preview,
        ...(r.gateImpact ? { gateImpact: r.gateImpact, gateImpactText: describeGateImpact(r.gateImpact) } : {}),
      });
    } catch (err) {
      // A refusal is a normal outcome, so it carries its CODE — the UI shows a
      // "Fork this" button for `not-yours` and a Reload for `stale`, which it
      // cannot do from a message string.
      if (err instanceof WorkflowEditRefused) {
        return NextResponse.json({ error: err.message, code: err.code, problems: err.problems }, { status: 409 });
      }
      throw err;
    }
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

/** Fork a workflow into one the user owns (FR-002).
 *
 *  Deliberately NOT the route for "change this pack's prompts" — that is the
 *  overlay, and it keeps receiving the pack's improvements. Forking to make a
 *  small change means never getting those again. */
export async function POST(req: NextRequest) {
  try {
    ensureBuiltinMethod();
    const { ensureInstalledMethodPacks } = await import("@/lib/specs/method/install");
    await ensureInstalledMethodPacks();

    const body = (await req.json()) as { source?: unknown; id?: unknown; label?: unknown };
    const source = String(body.source ?? "");
    const id = String(body.id ?? "");
    if (!source || !id) return NextResponse.json({ error: "source and id are required" }, { status: 400 });

    const { forkWorkflow, registerUserWorkflows } = await import("@/lib/specs/method/user-workflows");
    await forkWorkflow(source, id, body.label ? String(body.label) : undefined);
    const { failed } = await registerUserWorkflows();
    if (failed[id]) return NextResponse.json({ error: failed[id] }, { status: 400 });
    return NextResponse.json({ workflow: summarize(id, await ownedWorkflows()) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

/** Delete a workflow the user owns. A PACK's is refused — it is not BOS's to
 *  delete, and an action that always fails is worse than no action. */
export async function DELETE(req: NextRequest) {
  try {
    const id = new URL(req.url).searchParams.get("id") ?? "";
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

    const { readUserWorkflow, deleteUserWorkflow } = await import("@/lib/specs/method/user-workflows");
    if (!(await readUserWorkflow(id))) {
      return NextResponse.json(
        { error: `"${id}" is not one of your workflows — it comes from a pack. Uninstall the pack to remove it.` },
        { status: 400 },
      );
    }
    const { unregisterMethod } = await import("@/lib/specs/method/registry");
    await deleteUserWorkflow(id);
    unregisterMethod(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function GET(req: NextRequest) {
  try {
    // The registry is populated at boot, but instrumentation and route handlers
    // get separate module instances under Next — the reason ensureBuiltinMethod
    // self-heals lazily rather than trusting boot. Installed packs need the same.
    ensureBuiltinMethod();
    const { ensureInstalledMethodPacks } = await import("@/lib/specs/method/install");
    await ensureInstalledMethodPacks();

    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    const phase = url.searchParams.get("phase");
    if (id && phase) {
      // Both, because a phase may be described by either and the pane must not
      // claim "no prompt" while the pack's skill holds one (048 FR-028).
      const { readPhaseSkills } = await import("@/lib/specs/method/phase-skill");
      return NextResponse.json({
        instructions: await readPhaseInstructions(id, phase),
        skills: await readPhaseSkills(id, phase),
      });
    }
    const owned = await ownedWorkflows();
    if (id) {
      const detail = summarize(id, owned);
      if (!detail) return NextResponse.json({ error: `No workflow "${id}".` }, { status: 404 });
      if (detail.unreadable.length) {
        logger().warn(COMPONENT, "some file references could not be interpreted", { id, unreadable: detail.unreadable });
      }
      return NextResponse.json({ workflow: detail });
    }

    // The list view needs COUNTS, not the whole graph — sending every pack's
    // nodes and edges to render a summary row would grow with the corpus.
    const workflows: WorkflowSummary[] = listMethods()
      .map((m) => summarize(m.id, owned))
      .filter((w): w is WorkflowDetail => w !== null)
      .map((w) => ({
        id: w.id, label: w.label, version: w.version, builtin: w.builtin,
        phases: w.phases, links: w.links, gates: w.gates,
        isolated: w.isolated, customizable: w.customizable,
        ...(w.owned ? { owned: w.owned } : {}),
      }));

    return NextResponse.json({ workflows });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
