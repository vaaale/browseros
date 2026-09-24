"use client";

// 051 T005 — a workflow's pipeline, rendered.
//
// READ-ONLY, deliberately (Phase 1 / design §3.7). This phase exists to answer
// one question — is the picture worth the rest of the feature? — and editing
// would presuppose the answer.
//
// LAID OUT BY THE PACK'S DECLARED ORDER, with dependencies drawn OVER it as arcs.
//
// Not by dependency depth. `phases[]` declares a TOTAL ORDER — it is what
// PhaseStrip renders and what a user means by "the pipeline" — and only 2 of
// spec-kit's 11 consecutive steps are backed by a dependency. Laying out by depth
// scattered a pipeline whose order is mostly conventional, and put `ui-design`
// adrift even though the pack lists it fourth. Position now comes from the array;
// arcs show where that order is actually BACKED by something.
//
// The alternative — emitting the array as "follows" edges — over-claims: OpenSpec
// lists `specs, design, ui` consecutively and all three gate on `proposal`, so
// they are parallel. Edges between them would make parallel work look serial.
//
// Node styling is carried over from the Workflow app's own Graph.tsx, including
// OPAQUE fills: a translucent fill lets the SVG edge layer show through the node
// itself, the bug that component was fixed for.

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, ArrowRight, GitFork, Loader2, Lock, Package, Plus, RotateCcw, Trash2, Wrench } from "lucide-react";

interface Node { id: string; label: string; order: number; optional?: boolean; writes: string[]; reads: string[]; hasInstructions: boolean; skills: string[] }

/** What a phase's SKILL says — the answer to "what does this step do, how, and
 *  how do I change it" for a pack whose unit of work is a skill rather than a
 *  command file (048 FR-028). */
interface PhaseSkill {
  id: string;
  name: string;
  description: string;
  body: string;
  assets: string[];
  references: string[];
  /** The pack's OWN customisation schema. Present ⇒ BOS must NOT offer its
   *  overlay editor for this skill: two merges over one file makes "which
   *  version am I running" a question with two answers (048 FR-004). */
  customize: { rel: string; content: string } | null;
  missing: boolean;
}
interface Instructions { rel?: string; text: string; source: "overlay" | "pack" | "none"; edited: boolean; undeclared: boolean }
interface Edge { from: string; to: string; kind: "gate" | "artifact" | "flow"; via?: string }
interface Isolated { id: string; reason: "no-rules" | "reads-outside" | "output-unused" | "unconnected" }
interface Owned { from: string; fromVersion: string; rev: number; currentVersion: string | null; behind: boolean }

/** The closed op set (authoring.ts). Mirrored here rather than imported because
 *  this is a CLIENT component and `authoring.ts` is `server-only`; the server
 *  validates every one of these regardless, so a drift here is a rejected
 *  request rather than a bad write. */
type WorkflowOp =
  | { op: "addPhase"; id: string; label?: string; after?: string; optional?: boolean }
  | { op: "removePhase"; id: string }
  | { op: "renamePhase"; id: string; to?: string; label?: string }
  | { op: "movePhase"; id: string; after: string | null }
  | { op: "setRequires"; id: string; requires: string[] }
  | { op: "setOptional"; id: string; optional: boolean }
  | { op: "setArtifacts"; id: string; artifacts: string[] }
  | { op: "setSkills"; id: string; skills: string[] };

interface EditOutcome {
  ok: boolean;
  rev?: number;
  warnings?: string[];
  gateImpactText?: string;
  preview?: boolean;
  error?: string;
  code?: string;
}

/** One transport for every structural edit, mirroring the ONE server function
 *  behind it. `preview` runs the whole thing and writes nothing, which is how the
 *  gate warning is obtained — not by a second endpoint that guesses. */
async function patchWorkflow(id: string, op: WorkflowOp, rev: number, preview: boolean): Promise<EditOutcome> {
  const r = await fetch("/api/workflows", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, op, rev, preview }),
  });
  const d = (await r.json()) as EditOutcome & { error?: string };
  return r.ok ? { ...d, ok: true } : { ok: false, error: d.error ?? "The edit was refused.", code: d.code };
}
interface Detail {
  id: string; label: string; version: string; phases: number; links: number; gates: number;
  customizable: boolean; storeRoot: string; owned?: Owned;
  driverSkill?: string; describedPhases: number; builders: string[];
  nodes: Node[]; edges: Edge[]; isolatedPhases: Isolated[]; unreadable: string[];
}

const NODE_W = 140;
const NODE_H = 52;
const GAP_X = 60;
/** Vertical room above the strip for dependency arcs. */
const ARC_BAND = 88;

/** Why a phase stands apart, in the user's words. Never "unknown": an
 *  unexplained orphan reads as a rendering fault rather than the pack's design. */
const ISOLATION_TEXT: Record<Isolated["reason"], string> = {
  "no-rules": "declares no rules — it never reports on its own",
  "reads-outside": "reads a file no phase here produces",
  "output-unused": "writes something nothing here consumes",
  unconnected: "neither reads nor writes anything this workflow knows about",
};

const EDGE_STYLE = {
  gate:     { stroke: "#a78bfa", dash: undefined as string | undefined, marker: "wf-a-gate" },
  artifact: { stroke: "#ffffff66", dash: undefined as string | undefined, marker: "wf-a-soft" },
  flow:     { stroke: "#ffffff40", dash: "3 2", marker: "wf-a-dash" },
};

/** One row, in declared order. Arcs bow ABOVE the strip so a dependency that
 *  skips several steps (spec-kit's `specify -> plan` crosses three) stays legible
 *  instead of running through the nodes between. */
function layout(nodes: Node[]) {
  const pos = new Map<string, { x: number; y: number }>();
  const ordered = [...nodes].sort((a, b) => a.order - b.order);
  ordered.forEach((n, i) => pos.set(n.id, { x: i * (NODE_W + GAP_X), y: ARC_BAND }));
  return {
    pos,
    ordered,
    width: Math.max(NODE_W, ordered.length * (NODE_W + GAP_X)),
    height: ARC_BAND + NODE_H + 8,
  };
}

export function WorkflowCanvas({ workflowId, onClose, onOpen }: {
  workflowId: string;
  onClose?: () => void;
  /** Switch the canvas to another workflow — used after forking, so the user
   *  lands on the copy they just made rather than on the thing they forked. */
  onOpen?: (id: string) => void;
}) {
  const [forking, setForking] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  /** What the last edit did BEYOND what was asked (dropped gates, orphaned
   *  artifacts). Shown, never swallowed — they are consequences the user did not
   *  type. */
  const [notes, setNotes] = useState<string[]>([]);
  /** Bumped after every applied edit. The canvas re-reads the server's derived
   *  graph rather than patching its own copy: the edges are DERIVED from three
   *  declarations, and a client that recomputed them would be the second
   *  derivation this feature exists to avoid. */
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await fetch(`/api/workflows?id=${encodeURIComponent(workflowId)}`);
        const d = (await r.json()) as { workflow?: Detail; error?: string };
        if (!alive) return;
        if (!r.ok) { setError(d.error ?? "Could not load this workflow."); return; }
        setDetail(d.workflow ?? null);
        setError("");
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    return () => { alive = false; };
  }, [workflowId, reloads]);

  /** Apply one op. Returns the outcome so a caller can show a preview; reloads
   *  and clears the selection's staleness when it actually wrote. */
  const applyEdit = async (op: WorkflowOp, preview = false): Promise<EditOutcome> => {
    if (!detail?.owned) {
      return { ok: false, code: "not-yours", error: "This workflow comes from a pack and is read-only. Fork it to edit." };
    }
    setEditing(true);
    try {
      const out = await patchWorkflow(detail.id, op, detail.owned.rev, preview);
      if (out.ok && !preview) {
        setNotes(out.warnings ?? []);
        // A rename changes the id the inspector is keyed by, so follow it —
        // otherwise the pane empties and looks like the phase vanished.
        if (op.op === "renamePhase" && op.to) setSelected(op.to);
        if (op.op === "removePhase") setSelected(null);
        if (op.op === "addPhase") setSelected(op.id);
        setReloads((n) => n + 1);
      }
      return out;
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    } finally {
      setEditing(false);
    }
  };

  // EVERY phase is in the strip, in its declared position. A phase with no
  // dependency is still the fourth step if the pack lists it fourth — it is
  // marked, not moved.
  const unlinked = useMemo(
    () => new Map((detail?.isolatedPhases ?? []).map((i) => [i.id, i.reason])),
    [detail],
  );
  const { pos, ordered, width, height } = useMemo(() => layout(detail?.nodes ?? []), [detail]);

  const remove = async () => {
    if (!detail?.owned) return;
    setError("");
    const r = await fetch(`/api/workflows?id=${encodeURIComponent(detail.id)}`, { method: "DELETE" });
    if (!r.ok) {
      const d = (await r.json()) as { error?: string };
      setError(d.error ?? "Could not delete this workflow.");
      return;
    }
    onClose?.();
  };

  /** Add a phase at the END, then let the user move and name it.
   *
   *  A prompt() for the id rather than an inline form: this is the one op with no
   *  existing node to attach an editor to, and the alternative — a phase called
   *  "new-phase" that the user must then find and rename — leaves a real phase in
   *  a real pipeline named after the button that made it. */
  const addPhase = async () => {
    const raw = window.prompt("Phase id (lowercase letters, digits and dashes):", "");
    const id = (raw ?? "").trim();
    if (!id) return;
    const out = await applyEdit({ op: "addPhase", id, label: id });
    if (!out.ok) setError(out.error ?? "Could not add the phase.");
  };

  if (error) {
    return (
      <div className="flex items-start gap-2 p-4 text-[11px] text-amber-100">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <span>{error}</span>
      </div>
    );
  }
  if (!detail) return <div className="p-4 text-[11px] text-white/40">Loading…</div>;

  const node = detail.nodes.find((n) => n.id === selected) ?? null;
  const isolatedOf = detail.isolatedPhases.find((i) => i.id === selected) ?? null;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/10 px-4 py-2.5">
        <Package size={14} className="text-white/40" />
        <span className="text-[13px] font-medium">{detail.label}</span>
        <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-white/50">
          {detail.phases} phases · {detail.links} links
        </span>
        {detail.gates > 0 && (
          <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] text-violet-200">{detail.gates} enforced gates</span>
        )}
        {/* Stated HERE because it is a fact about the pack, not a surprise per
            phase. BMAD and OpenSpec declare prompts for NONE of their steps, and
            finding that out by clicking every node in turn reads as a broken
            pane rather than as the pack's design. */}
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] ${detail.describedPhases === 0 ? "bg-white/10 text-white/40" : "bg-white/10 text-white/50"}`}
          title={
            detail.describedPhases === 0
              ? `${detail.label} says nothing about any of its phases${detail.driverSkill ? ` — it drives from the "${detail.driverSkill}" skill instead` : ""}.`
              : `${detail.describedPhases} of ${detail.phases} phases declare a prompt or a skill.`
          }
        >
          {detail.describedPhases} of {detail.phases} described
        </span>
        {detail.owned ? (
          <>
            <span className="inline-flex items-center gap-1 rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] text-violet-200">
              <GitFork size={9} /> yours
            </span>
            <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-white/40">
              forked from {detail.owned.from} @ {detail.owned.fromVersion}
            </span>
            {/* FR-008 — a NOTICE, never a merge. An upgrade is "fork the new
                version and re-apply my changes", which needs judgement about
                whether a renamed phase still means the same thing; an agent can
                answer that and say what it did, a merge engine answers it
                silently. So this says there is something to re-fork FROM. */}
            {detail.owned.behind && (
              <span
                className="inline-flex items-center gap-1 rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] text-amber-200"
                title={`Ask the assistant to upgrade "${detail.id}" to ${detail.owned.from} ${detail.owned.currentVersion}. It will re-fork and re-apply your changes.`}
              >
                <AlertTriangle size={9} /> {detail.owned.from} is now @ {detail.owned.currentVersion}
              </span>
            )}
            {detail.owned.currentVersion === null && (
              <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-white/35">
                {detail.owned.from} is no longer installed — this fork still works
              </span>
            )}
          </>
        ) : (
          <span className="inline-flex items-center gap-1 rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-white/40">
            <Lock size={10} /> from a pack
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {detail.owned && (
            <button
              onClick={() => void addPhase()}
              disabled={editing}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-white/60 hover:bg-white/10 disabled:opacity-40"
              title="Add a phase at the end of the pipeline"
            >
              <Plus size={11} /> Phase
            </button>
          )}
          {detail.owned ? (
            <button
              onClick={() => void remove()}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-rose-300/80 hover:bg-rose-500/15"
              title="Delete this workflow. The pack it came from is untouched."
            >
              <Trash2 size={11} /> Delete
            </button>
          ) : (
            <button
              onClick={() => setForking(true)}
              className="inline-flex items-center gap-1 rounded bg-violet-500/80 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-violet-500"
            >
              <GitFork size={11} /> Fork
            </button>
          )}
          {onClose && (
            <button onClick={onClose} className="rounded px-2 py-1 text-[11px] text-white/50 hover:bg-white/10">
              Back to specs
            </button>
          )}
        </div>
      </div>

      {/* The legend is load-bearing: three edge kinds, and only one is enforced. */}
      <div className="flex shrink-0 flex-wrap items-center gap-4 border-b border-white/10 bg-white/[0.02] px-4 py-2 text-[10px] text-white/45">
        <Legend stroke="#a78bfa" label="gate — enforced, blocks the phase" />
        <Legend stroke="#ffffff66" label="artifact dependency — declared order" />
        <Legend stroke="#ffffff40" dash label="data flow — derived, read-only" />
        <span className="text-white/30">left to right = the order the pack declares; arcs = what actually depends on what</span>
      </div>

      {forking && (
        <ForkDialog
          workflow={detail}
          onCancel={() => setForking(false)}
          onForked={(id) => { setForking(false); onOpen?.(id); }}
        />
      )}

      {!!notes.length && (
        <div className="shrink-0 border-b border-sky-400/20 bg-sky-400/10 px-4 py-2 text-[11px] text-sky-100">
          {notes.map((n) => <div key={n}>{n}</div>)}
        </div>
      )}

      {!!detail.unreadable.length && (
        <div className="flex shrink-0 items-start gap-2 border-b border-amber-400/20 bg-amber-400/10 px-4 py-2 text-[11px] text-amber-100">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span>
            {detail.unreadable.length} file reference(s) could not be interpreted, so some links may be missing:{" "}
            {detail.unreadable.join("; ")}
          </span>
        </div>
      )}

      {/* Canvas above, inspector BELOW. The pipeline is a horizontal strip, so a
          right-hand pane fought it for the one axis the graph needs, and the
          inspector had 288px for a phase's whole prompt. Stacked, the strip gets
          the full width and the detail gets room to be read. */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-auto bg-[#0f1117] p-4">
          <svg width={width} height={height + 8} className="max-w-none">
            <defs>
              {Object.entries(EDGE_STYLE).map(([kind, s]) => (
                <marker key={kind} id={s.marker} markerWidth="7" markerHeight="7" refX="6" refY="2.5" orient="auto">
                  <path d="M0,0 L0,5 L6,2.5 z" fill={s.stroke} />
                </marker>
              ))}
            </defs>

            {detail.edges.map((e, i) => {
              const a = pos.get(e.from);
              const b = pos.get(e.to);
              if (!a || !b) return null;
              const st = EDGE_STYLE[e.kind];
              // Bow above the strip, higher the further the arc reaches, so a
              // dependency that skips several steps does not run through the
              // nodes between it.
              const x1 = a.x + NODE_W / 2, x2 = b.x + NODE_W / 2;
              const span = Math.abs(x2 - x1) / (NODE_W + GAP_X);
              const lift = Math.min(ARC_BAND - 12, 22 + span * 16);
              const top = a.y - lift;
              return (
                <g key={`${e.from}-${e.to}-${e.kind}-${i}`}>
                  <path
                    d={`M${x1},${a.y} C${x1},${top} ${x2},${top} ${x2},${b.y}`}
                    stroke={st.stroke}
                    strokeDasharray={st.dash}
                    fill="none"
                    markerEnd={`url(#${st.marker})`}
                  />
                  {e.via && (
                    <text x={(x1 + x2) / 2} y={top + 10} fill={st.stroke} fontSize="9" textAnchor="middle">{e.via}</text>
                  )}
                </g>
              );
            })}

            {ordered.map((n) => {
              const p = pos.get(n.id);
              if (!p) return null;
              const on = selected === n.id;
              const iso = unlinked.get(n.id);
              return (
                <g key={n.id} onClick={() => setSelected(n.id)} style={{ cursor: "pointer" }}>
                  {/* Opaque fill — see the header note. A dashed border marks a
                      phase nothing declares a dependency on; it keeps its place. */}
                  <rect
                    x={p.x} y={p.y} width={NODE_W} height={NODE_H} rx="8"
                    fill={on ? "#1a1830" : "#1b1d23"}
                    stroke={on ? "#a78bfa" : iso ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.15)"}
                    strokeWidth={on ? 1.5 : 1}
                    strokeDasharray={iso && !on ? "4 3" : undefined}
                  />
                  <text x={p.x + 14} y={p.y + 22} fill={on ? "#ddd6fe" : "rgba(255,255,255,0.85)"} fontSize="12" fontWeight="500">
                    {n.optional ? `[${n.label}]` : n.label}
                  </text>
                  <text x={p.x + 14} y={p.y + 38} fill="rgba(255,255,255,0.35)" fontSize="10">
                    {n.writes.length ? `writes ${n.writes[0]}` : n.reads.length ? `reads ${n.reads[0]}` : "observes nothing"}
                  </text>
                  {/* A prompt is the thing a phase most IS, so whether one exists
                      belongs on the node. Without it the only way to learn that a
                      pack ships none is to click every step. */}
                  {n.hasInstructions && (
                    <circle cx={p.x + NODE_W - 12} cy={p.y + 12} r="3" fill="#a78bfa" opacity="0.75">
                      <title>declares a prompt</title>
                    </circle>
                  )}
                </g>
              );
            })}

          </svg>

          {!!detail.isolatedPhases.length && (
            <p className="mt-3 text-[10px] text-white/35">
              {detail.isolatedPhases.length} of {detail.phases} phases (dashed) have no declared dependency —
              BOS cannot observe how they connect to the rest. They keep their place in the pipeline.
            </p>
          )}
        </div>

        {/* Inspector — ONLY what the pack declared (FR-020). Absence renders as
            absence; BOS never fills a gap with a plausible default.
            Half the height when a phase is selected; a single line otherwise, so
            an empty pane never costs half the view. */}
        <aside
          className={`shrink-0 overflow-auto border-t border-white/10 ${node ? "h-1/2 p-3" : "px-4 py-2"}`}
        >
          {!node ? (
            <p className="text-[11px] text-white/35">Select a phase to see what it does, how, and how to change it.</p>
          ) : (
            <PhaseInspector
              key={node.id}
              workflowId={detail.id}
              node={node}
              isolationText={isolatedOf ? ISOLATION_TEXT[isolatedOf.reason] : undefined}
              methodLabel={detail.label}
              driverSkill={detail.driverSkill}
              builders={detail.builders}
              packDeclaresNone={detail.describedPhases === 0}
              phases={ordered}
              gates={detail.edges.filter((e) => e.kind === "gate")}
              editable={Boolean(detail.owned)}
              editBusy={editing}
              onEdit={applyEdit}
              onClose={() => setSelected(null)}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

function Legend({ stroke, dash, label }: { stroke: string; dash?: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg width="26" height="8">
        <line x1="0" y1="4" x2="20" y2="4" stroke={stroke} strokeWidth="1.5" strokeDasharray={dash ? "3 2" : undefined} />
        <path d="M20,1 L26,4 L20,7z" fill={stroke} />
      </svg>
      {label}
    </span>
  );
}

function Field({ label, values }: { label: string; values: string[] }) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-wide text-white/40">{label}</label>
      {values.length === 0 ? (
        <div className="mt-1 text-[11px] text-white/35">nothing</div>
      ) : (
        <div className="mt-1 space-y-1">
          {values.map((v) => (
            <div key={v} className="rounded border border-white/10 bg-black/20 px-2 py-1 text-[11px] text-white/60">{v}</div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A phase's declared facts, and its INSTRUCTIONS — editable.
 *
 *  The prompt is what the phase actually is; writes/reads are trivia beside it.
 *  It is fetched per phase rather than with the graph because sending twelve
 *  prompts to render a strip would ship most of a pack on every open.
 *
 *  Saving posts to the same route the agent's tool calls (FR-019/FR-022). There
 *  is no path here that writes into a pack — the server decides that, and it only
 *  ever writes the overlay. */
function PhaseInspector({ workflowId, node, isolationText, methodLabel, driverSkill, builders, packDeclaresNone, phases, gates, editable, editBusy, onEdit, onClose }: {
  workflowId: string;
  node: Node;
  isolationText?: string;
  methodLabel: string;
  /** The skill that teaches an agent to run this pipeline. For a pack with no
   *  per-phase prompts this is WHERE ITS INSTRUCTIONS ACTUALLY ARE, and saying
   *  so is the difference between "empty" and "organised differently". */
  driverSkill?: string;
  /** Skills this pack ships that AUTHOR new content — the route out of an empty
   *  phase (048 FR-029). */
  builders: string[];
  /** True when NO phase in this workflow declares a prompt — a fact about the
   *  pack, which reads very differently from one phase happening to lack one. */
  packDeclaresNone: boolean;
  /** Every phase in declared order — what `requires` may name and what `move`
   *  moves through. */
  phases: Node[];
  /** The ENFORCED edges, which is where this phase's current `requires` list
   *  comes from. Derived server-side; the inspector reads it rather than
   *  reconstructing it. */
  gates: Edge[];
  /** A pack's workflow is read-only. Not hidden — stated, with the way out. */
  editable: boolean;
  editBusy: boolean;
  onEdit: (op: WorkflowOp, preview?: boolean) => Promise<EditOutcome>;
  onClose: () => void;
}) {
  const [instr, setInstr] = useState<Instructions | null>(null);
  const [skills, setSkills] = useState<PhaseSkill[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // The documented fetch-in-effect shape: the request is a plain promise and
  // every setState happens in a CALLBACK, which is what React's compiler asks
  // for and what `set-state-in-effect` was rejecting before.
  //
  // `ignore` is not ceremony. This inspector is remounted with a new `node.id`
  // on every phase click, and without the guard clicking A then B before A's
  // response lands writes A's instructions into B's pane — the slower request
  // wins because it resolves last.
  //
  // The error clears on SUCCESS rather than on the intent to try: during a
  // refetch the previous failure is still the truth.
  useEffect(() => {
    let ignore = false;
    fetch(`/api/workflows?id=${encodeURIComponent(workflowId)}&phase=${encodeURIComponent(node.id)}`)
      .then(async (r) => {
        const d = (await r.json()) as { instructions?: Instructions; skills?: PhaseSkill[]; error?: string };
        if (!r.ok) throw new Error(d.error ?? "Could not load the instructions.");
        return d;
      })
      .then(
        (loaded) => {
          if (ignore) return;
          setInstr(loaded.instructions ?? null);
          setSkills(loaded.skills ?? []);
          setDraft(loaded.instructions?.text ?? "");
          setError("");
        },
        (err: unknown) => {
          if (!ignore) setError((err as Error).message);
        },
      );
    return () => {
      ignore = true;
    };
  }, [workflowId, node.id]);

  const save = async (revert: boolean) => {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/workflows", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: workflowId, phase: node.id, text: draft, revert }),
      });
      const d = (await r.json()) as { instructions?: Instructions; error?: string };
      if (!r.ok) throw new Error(d.error ?? "Could not save.");
      setInstr(d.instructions ?? null);
      setDraft(d.instructions?.text ?? "");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const dirty = instr !== null && draft !== instr.text;
  /** Does the PACK own how this step is customised? If any of the phase's skills
   *  ships a `customize.toml`, yes — and BOS's overlay editor is withdrawn
   *  rather than offered alongside it. Two ways to change one thing is the shape
   *  every defect in this subsystem has taken, and here it would also mean BOS
   *  layering a second merge under BMAD's own (048 FR-004). */
  const packOwnsCustomisation = skills.some((sk) => sk.customize !== null);

  return (
    <>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-white/50">
          {node.optional ? `[${node.label}]` : node.label}
        </h3>
        {node.optional && (
          <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-white/40">optional — may be skipped</span>
        )}
        {instr?.edited && <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-200">edited</span>}
        <button
          onClick={onClose}
          className="ml-auto rounded px-2 py-0.5 text-[11px] text-white/40 hover:bg-white/10 hover:text-white/70"
          title="Close — the canvas gets the full height back"
        >
          close
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-3">
          <div>
          <div className="flex items-center gap-1.5">
            <label className="text-[10px] uppercase tracking-wide text-white/40">Instructions</label>
            <span className="text-[9px] text-white/30">
              {instr?.source === "pack" ? `from ${methodLabel}` : instr?.source === "overlay" ? "yours" : "none yet"}
            </span>
            {instr?.edited && (
              <button
                onClick={() => void save(true)}
                disabled={busy}
                className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-white/40 hover:bg-white/10 disabled:opacity-40"
                title={`Discard your version and use ${methodLabel}'s again`}
              >
                <RotateCcw size={9} /> revert
              </button>
            )}
          </div>

          {instr === null ? (
            <div className="mt-1 flex items-center gap-1.5 text-[11px] text-white/35">
              <Loader2 size={11} className="animate-spin" /> loading…
            </div>
          ) : packOwnsCustomisation ? (
            // The pack customises itself. BOS shows the surface and routes the
            // WRITE to the pack's own mechanism — offering its overlay here
            // would put two merges over one file (048 FR-004).
            <p className="mt-1 text-[10px] leading-snug text-white/35">
              {methodLabel} owns this step&apos;s prompt and how it is changed — see below.
            </p>
          ) : (
            <>
              {instr.undeclared && !instr.edited && (
                <div className="mt-1 rounded border border-white/10 bg-black/20 px-2.5 py-2 text-[10px] leading-relaxed text-white/45">
                  {packDeclaresNone ? (
                    <>
                      <span className="text-white/60">{methodLabel} says nothing about any of its phases.</span>{" "}
                      {driverSkill ? (
                        <>
                          Its knowledge lives in the <span className="font-mono text-white/60">{driverSkill}</span> skill,
                          which the agent already loads — so this is how the pack is organised, not something missing.
                        </>
                      ) : (
                        <>This pack ships no prompts anywhere BOS can see them.</>
                      )}
                    </>
                  ) : (
                    <>
                      <span className="text-white/60">{methodLabel} says nothing about this step</span>, though it does
                      for others. BOS will not guess one from a filename — a pack says where its prompts are, or has none.
                    </>
                  )}
                  <div className="mt-1.5 text-white/35">
                    Write one below to add it. It is stored outside the pack, so it survives an upgrade — and no fork is needed.
                  </div>
                </div>
              )}
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                rows={14}
                placeholder={`What should the agent do for "${node.label}"?`}
                className="mt-1 w-full resize-y rounded border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-white/80 outline-none focus:border-white/30"
              />
              <div className="mt-1.5 flex items-center gap-2">
                <button
                  onClick={() => void save(false)}
                  disabled={busy || !dirty}
                  className="rounded bg-violet-500/80 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-violet-500 disabled:opacity-40"
                >
                  {busy ? "Saving…" : "Save"}
                </button>
                {dirty && (
                  <button onClick={() => setDraft(instr.text)} className="text-[11px] text-white/40 hover:text-white/70">
                    discard changes
                  </button>
                )}
                <span className="ml-auto truncate text-[9px] text-white/25" title={instr.rel}>{instr.rel}</span>
              </div>
              <p className="mt-1 text-[9px] leading-snug text-white/30">
                Saved outside the pack, so it survives updating or reinstalling {methodLabel}.
              </p>
            </>
          )}

          {error && (
            <div className="mt-2 flex items-start gap-1.5 rounded border border-amber-400/20 bg-amber-400/10 px-2 py-1.5 text-[10px] text-amber-100">
              <AlertTriangle size={10} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {skills.map((sk) => (
          <SkillPanel key={sk.id} skill={sk} methodLabel={methodLabel} />
        ))}

        {/* A phase with nothing to run. On a fork this is the ordinary state of a
            step you just added, so it must offer the way FORWARD rather than
            just naming the hole. */}
        {skills.length === 0 && node.skills.length === 0 && editable && (
          <div className="rounded border border-white/10 bg-black/20 px-2.5 py-2 text-[10px] leading-relaxed text-white/45">
            <span className="text-white/60">No skill performs this step yet</span>, so nothing runs when it is reached.
            {builders.length > 0 ? (
              <>
                {" "}
                {methodLabel} ships a builder for exactly this. Ask the assistant:
                <div className="mt-1.5 rounded border border-white/10 bg-black/40 px-2 py-1.5 font-mono text-[9px] leading-relaxed text-white/70">
                  Use {builders[0]} to author a skill for the &quot;{node.label}&quot; phase of {workflowId}, then attach it.
                </div>
                <div className="mt-1.5 text-white/35">
                  It authors the skill, then attaches it with <span className="font-mono">methods_edit</span>&apos;s{" "}
                  <span className="font-mono">setSkills</span>. BOS does not run the builder itself — it is a skill, and the
                  assistant already has it.
                </div>
              </>
            ) : (
              <>
                {" "}
                {methodLabel} ships no builder, so write the prompt above, or ask the assistant to author a skill and attach
                it with <span className="font-mono">methods_edit</span>&apos;s <span className="font-mono">setSkills</span>.
              </>
            )}
          </div>
        )}
        </div>

        {/* Right column: the DECLARED facts and the pipeline's shape. Narrow on
            purpose — these are short lists, and the prompt on the left is what
            needs the width. */}
        <div className="min-w-0 space-y-3">
        <Field label="Writes" values={node.writes} />
        <Field label="Reads" values={node.reads} />

        <StructureEditor
          node={node}
          phases={phases}
          gates={gates}
          editable={editable}
          busy={editBusy}
          methodLabel={methodLabel}
          onEdit={onEdit}
        />

        {isolationText && (
          <div className="flex items-start gap-2 rounded border border-amber-400/20 bg-amber-400/10 px-2.5 py-2 text-[11px] text-amber-100">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span>This phase {isolationText}. That is {methodLabel}&apos;s choice, not a fault.</span>
          </div>
        )}
        </div>
      </div>
    </>
  );
}


/**
 * What a phase's skill says: what it does, how it does it, how to change it.
 *
 * The three questions the inspector exists to answer, and before this it
 * answered none of them for BMAD — every phase reported "declares no prompts"
 * while `bmad-prd` alone carried a 14k prompt, four assets, two references and
 * an 8k customisation schema.
 *
 * The schema is shown VERBATIM and never parsed. BMAD's own docs call
 * `customize.toml` the schema — "read it to see what is customizable" — and
 * parsing it would mean modelling merge semantics BOS does not own (FR-004). So
 * BOS shows it and routes the write to the pack.
 */
function SkillPanel({ skill, methodLabel }: { skill: PhaseSkill; methodLabel: string }) {
  const [open, setOpen] = useState(false);
  const [showSchema, setShowSchema] = useState(false);

  if (skill.missing) {
    return (
      <div className="rounded border border-amber-400/20 bg-amber-400/10 px-2.5 py-2 text-[10px] leading-snug text-amber-100">
        <AlertTriangle size={10} className="mr-1 inline" />
        This phase names the skill <span className="font-mono">{skill.id}</span>, which is not installed. Nothing will run it.
      </div>
    );
  }

  return (
    <div className="rounded border border-white/10 bg-black/20">
      <div className="flex items-center gap-1.5 border-b border-white/10 px-2.5 py-1.5">
        <Wrench size={11} className="shrink-0 text-white/40" />
        <span className="truncate font-mono text-[11px] text-white/70">{skill.id}</span>
        {skill.customize && (
          <span className="ml-auto shrink-0 rounded bg-violet-500/15 px-1.5 py-0.5 text-[9px] text-violet-200">customizable</span>
        )}
      </div>

      <div className="space-y-2 px-2.5 py-2">
        {/* WHAT IT DOES */}
        {skill.description && (
          <p className="text-[11px] leading-relaxed text-white/60">{skill.description}</p>
        )}

        {/* HOW IT DOES IT */}
        {(skill.assets.length > 0 || skill.references.length > 0) && (
          <div className="space-y-1">
            {skill.assets.length > 0 && (
              <div className="text-[10px] text-white/40">
                <span className="uppercase tracking-wide text-white/30">works from</span>{" "}
                {skill.assets.map((a) => (
                  <span key={a} className="mr-1 inline-block rounded bg-white/5 px-1 py-0.5 font-mono text-[9px] text-white/55">{a}</span>
                ))}
              </div>
            )}
            {skill.references.length > 0 && (
              <div className="text-[10px] text-white/40">
                <span className="uppercase tracking-wide text-white/30">reads</span>{" "}
                {skill.references.map((r) => (
                  <span key={r} className="mr-1 inline-block rounded bg-white/5 px-1 py-0.5 font-mono text-[9px] text-white/55">{r}</span>
                ))}
              </div>
            )}
          </div>
        )}

        <button onClick={() => setOpen((v) => !v)} className="text-[10px] text-white/45 hover:text-white/80">
          {open ? "hide" : "show"} the full prompt ({skill.body.length.toLocaleString()} chars)
        </button>
        {open && (
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded border border-white/10 bg-black/40 px-2 py-1.5 font-mono text-[9px] leading-relaxed text-white/65">
            {skill.body.trim()}
          </pre>
        )}

        {/* HOW TO CHANGE IT */}
        {skill.customize ? (
          <div className="space-y-1.5 border-t border-white/10 pt-2">
            <div className="text-[10px] uppercase tracking-wide text-white/40">To change it</div>
            <p className="text-[10px] leading-relaxed text-white/50">
              {methodLabel} customises this itself. Write a SPARSE override at{" "}
              <span className="font-mono text-white/65">_bmad/custom/{skill.id}.toml</span> in your repository — or just ask
              the assistant, which uses the pack&apos;s own <span className="font-mono">bmad-customize</span> skill.
            </p>
            <p className="text-[9px] leading-snug text-white/30">
              Never edit <span className="font-mono">{skill.customize.rel}</span> itself, and never copy it whole: it is
              overwritten on update, and a full copy freezes today&apos;s defaults so the next release silently does nothing.
            </p>
            <button onClick={() => setShowSchema((v) => !v)} className="text-[10px] text-white/45 hover:text-white/80">
              {showSchema ? "hide" : "show"} what is customizable
            </button>
            {showSchema && (
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded border border-white/10 bg-black/40 px-2 py-1.5 font-mono text-[9px] leading-relaxed text-white/65">
                {skill.customize.content.trim()}
              </pre>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Every structural operation, reachable (design §3.7).
 *
 * A LIST, not a drag. Of the three edge kinds only gates are editable at all —
 * artifact dependencies are edited on the artifact, data flow is derived — so
 * drag-to-connect would apply to the rarest kind, and to the one that needs a
 * warning before it applies. A modal confirmation at the end of a drag is a poor
 * interaction; a checkbox followed by "what will this block?" is not.
 *
 * The gate list is the only control here that PREVIEWS first. It is the only one
 * that can change what existing features report.
 */
function StructureEditor({ node, phases, gates, editable, busy, methodLabel, onEdit }: {
  node: Node;
  phases: Node[];
  gates: Edge[];
  editable: boolean;
  busy: boolean;
  methodLabel: string;
  onEdit: (op: WorkflowOp, preview?: boolean) => Promise<EditOutcome>;
}) {
  const current = useMemo(
    () => gates.filter((e) => e.to === node.id).map((e) => e.from).sort(),
    [gates, node.id],
  );
  const [draft, setDraft] = useState<string[]>(current);
  const [pending, setPending] = useState<{ text: string; requires: string[] } | null>(null);
  const [label, setLabel] = useState(node.label);
  const [id, setId] = useState(node.id);
  const [problem, setProblem] = useState("");

  // A fresh phase is a fresh inspector (`key={node.id}` upstream), so `label`
  // and `id` initialise once. `current` is the exception: it changes under us
  // when an applied edit reloads the graph, and the draft must follow or the
  // checkboxes keep showing what the user asked for rather than what happened.
  //
  // Adjusted DURING RENDER rather than in an effect — React's own answer for
  // "reset state when a prop changes", and the reason it is not an effect is
  // that an effect would render the stale value first and then immediately
  // re-render, which is the cascade `set-state-in-effect` exists to stop.
  const [gateSignature, setGateSignature] = useState(current.join());
  if (gateSignature !== current.join()) {
    setGateSignature(current.join());
    setDraft(current);
  }

  if (!editable) {
    return (
      <div className="rounded border border-white/10 bg-black/20 px-2.5 py-2 text-[10px] leading-snug text-white/40">
        <Lock size={10} className="mr-1 inline" />
        {methodLabel} owns this pipeline, so its shape is read-only. Fork it to change which steps
        exist, what they are called, or what gates them — the prompt above is editable either way.
      </div>
    );
  }

  const run = async (op: WorkflowOp) => {
    setProblem("");
    const out = await onEdit(op);
    if (!out.ok) setProblem(out.error ?? "Refused.");
  };

  const gatesChanged = draft.join() !== current.join();
  const index = phases.findIndex((p) => p.id === node.id);

  /** Preview first, and only ask again when there is something to be asked
   *  about. A confirmation that always appears is one nobody reads. */
  const applyGates = async () => {
    setProblem("");
    const preview = await onEdit({ op: "setRequires", id: node.id, requires: draft }, true);
    if (!preview.ok) { setProblem(preview.error ?? "Refused."); return; }
    const blocks = preview.gateImpactText && !/blocks nothing|nothing was checked/.test(preview.gateImpactText);
    if (blocks) { setPending({ text: preview.gateImpactText!, requires: draft }); return; }
    await run({ op: "setRequires", id: node.id, requires: draft });
  };

  return (
    <div className="space-y-3 border-t border-white/10 pt-3">
      <div className="text-[10px] uppercase tracking-wide text-white/40">Structure</div>

      {/* Name ------------------------------------------------------------- */}
      <div className="space-y-1.5">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label"
          className="w-full rounded border border-white/10 bg-black/30 px-2 py-1 text-[11px] text-white/80 outline-none focus:border-white/30"
        />
        <input
          value={id}
          onChange={(e) => setId(e.target.value)}
          spellCheck={false}
          placeholder="id"
          className="w-full rounded border border-white/10 bg-black/30 px-2 py-1 font-mono text-[10px] text-white/60 outline-none focus:border-white/30"
        />
        {(label !== node.label || id !== node.id) && (
          <button
            onClick={() => void run({ op: "renamePhase", id: node.id, to: id !== node.id ? id : undefined, label })}
            disabled={busy}
            className="rounded bg-violet-500/80 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-violet-500 disabled:opacity-40"
          >
            Rename
          </button>
        )}
        <p className="text-[9px] leading-snug text-white/25">
          Renaming the id rewrites every reference to it. The prompt file keeps its own name.
        </p>
      </div>

      {/* Optional --------------------------------------------------------- */}
      <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-white/60">
        <input
          type="checkbox"
          checked={Boolean(node.optional)}
          disabled={busy}
          onChange={(e) => void run({ op: "setOptional", id: node.id, optional: e.target.checked })}
        />
        Optional — may be skipped
      </label>

      {/* Position --------------------------------------------------------- */}
      <div>
        <div className="text-[10px] uppercase tracking-wide text-white/40">Position</div>
        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-white/50">
          <button
            onClick={() => void run({ op: "movePhase", id: node.id, after: index >= 2 ? phases[index - 2].id : null })}
            disabled={busy || index === 0}
            className="rounded border border-white/10 px-1.5 py-0.5 hover:bg-white/10 disabled:opacity-30"
          >
            <ArrowLeft size={11} />
          </button>
          <button
            onClick={() => void run({ op: "movePhase", id: node.id, after: phases[index + 1].id })}
            disabled={busy || index === phases.length - 1}
            className="rounded border border-white/10 px-1.5 py-0.5 hover:bg-white/10 disabled:opacity-30"
          >
            <ArrowRight size={11} />
          </button>
          <span className="text-white/35">step {index + 1} of {phases.length}</span>
        </div>
        <p className="mt-1 text-[9px] leading-snug text-white/25">
          Order is the pipeline. It is what the strip renders, and most of it is convention rather than dependency.
        </p>
      </div>

      {/* Gates ------------------------------------------------------------ */}
      <div>
        <div className="text-[10px] uppercase tracking-wide text-white/40">Waits for (enforced)</div>
        <div className="mt-1 space-y-0.5">
          {phases.filter((p) => p.id !== node.id).map((p) => (
            <label key={p.id} className="flex cursor-pointer items-center gap-1.5 text-[11px] text-white/55">
              <input
                type="checkbox"
                checked={draft.includes(p.id)}
                disabled={busy}
                onChange={(e) =>
                  setDraft((d) => (e.target.checked ? [...d, p.id].sort() : d.filter((x) => x !== p.id)))
                }
              />
              {p.label}
            </label>
          ))}
        </div>
        {gatesChanged && !pending && (
          <div className="mt-1.5 flex items-center gap-2">
            <button
              onClick={() => void applyGates()}
              disabled={busy}
              className="rounded bg-violet-500/80 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-violet-500 disabled:opacity-40"
            >
              {busy ? "Checking…" : "Apply"}
            </button>
            <button onClick={() => setDraft(current)} className="text-[10px] text-white/40 hover:text-white/70">
              discard
            </button>
          </div>
        )}
        <p className="mt-1 text-[9px] leading-snug text-white/25">
          The only edge BOS enforces: unsatisfied, the phase reports Blocked.
        </p>
      </div>

      {pending && (
        <div className="space-y-2 rounded border border-amber-400/30 bg-amber-400/10 px-2.5 py-2 text-[10px] text-amber-100">
          <pre className="whitespace-pre-wrap font-sans leading-snug">{pending.text}</pre>
          <div className="flex items-center gap-2">
            <button
              onClick={async () => { const r = pending.requires; setPending(null); await run({ op: "setRequires", id: node.id, requires: r }); }}
              disabled={busy}
              className="rounded bg-amber-500/80 px-2 py-0.5 font-medium text-black hover:bg-amber-500 disabled:opacity-40"
            >
              Apply anyway
            </button>
            <button onClick={() => { setPending(null); setDraft(current); }} className="text-amber-200/70 hover:text-amber-100">
              cancel
            </button>
          </div>
        </div>
      )}

      {/* Remove ----------------------------------------------------------- */}
      <button
        onClick={() => void run({ op: "removePhase", id: node.id })}
        disabled={busy}
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-rose-300/80 hover:bg-rose-500/15 disabled:opacity-40"
      >
        <Trash2 size={10} /> Remove this phase
      </button>

      {problem && (
        <div className="flex items-start gap-1.5 rounded border border-amber-400/20 bg-amber-400/10 px-2 py-1.5 text-[10px] text-amber-100">
          <AlertTriangle size={10} className="mt-0.5 shrink-0" />
          <span>{problem}</span>
        </div>
      )}
    </div>
  );
}

/** Fork, framed by CONSEQUENCE rather than mechanism (FR-004).
 *
 *  The choice a user actually faces is not "fork or override" — it is "do I want
 *  a separate variant, or do I want THIS pack to behave differently". Those have
 *  very different costs, and the expensive mistake is forking to make a small
 *  change and thereby never receiving the pack's improvements again. So the
 *  cheaper route is offered FIRST and by name.
 */
function ForkDialog({ workflow, onCancel, onForked }: {
  workflow: Detail;
  onCancel: () => void;
  onForked: (id: string) => void;
}) {
  const [id, setId] = useState(`${workflow.id}-mine`);
  const [label, setLabel] = useState(`${workflow.label} (mine)`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const go = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: workflow.id, id: id.trim(), label: label.trim() }),
      });
      const d = (await r.json()) as { error?: string };
      if (!r.ok) { setError(d.error ?? "Could not fork."); return; }
      onForked(id.trim());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[200000] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[520px] max-w-[92vw] rounded-2xl border border-white/10 bg-[#15171e] p-6 text-sm shadow-2xl">
        <h4 className="text-[13px] font-semibold">Fork “{workflow.label}”?</h4>
        <p className="mt-1 text-[11px] text-white/50">Two different things, and the difference is what happens when {workflow.label} updates.</p>

        <div className="mt-4 space-y-2">
          <div className="rounded border border-white/10 bg-black/20 p-3">
            <div className="flex items-center gap-1.5 text-xs font-medium text-white/80">
              <RotateCcw size={13} /> Just change its prompts
            </div>
            <p className="mt-1 text-[11px] text-white/40">
              Select any phase and edit its instructions. Your version is kept outside the pack, so it survives updates
              — and you <b className="text-white/70">keep receiving</b> {workflow.label}&apos;s other improvements. No fork needed.
            </p>
            <button onClick={onCancel} className="mt-2 rounded bg-white/10 px-2 py-1 text-[11px] font-medium hover:bg-white/20">
              Do that instead
            </button>
          </div>

          <div className="rounded border border-white/30 bg-white/10 p-3">
            <div className="flex items-center gap-1.5 text-xs font-medium"><GitFork size={13} /> Fork it</div>
            <p className="mt-1 text-[11px] text-white/40">
              A separate, independently named workflow you bind to whichever stores you choose, leaving the rest on
              {" "}{workflow.label}. <b className="text-white/70">{workflow.label}&apos;s future changes will not reach it.</b>
            </p>
          </div>
        </div>

        <div className="mt-4 space-y-2">
          <div className="grid grid-cols-[80px_1fr] items-center gap-2">
            <label className="text-xs text-white/60">Id</label>
            <input value={id} onChange={(e) => setId(e.target.value)} spellCheck={false}
              className="min-w-0 rounded border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-xs outline-none focus:border-white/30" />
          </div>
          <div className="grid grid-cols-[80px_1fr] items-center gap-2">
            <label className="text-xs text-white/60">Name</label>
            <input value={label} onChange={(e) => setLabel(e.target.value)}
              className="min-w-0 rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none focus:border-white/30" />
          </div>
        </div>

        {error && (
          <div className="mt-3 flex items-start gap-2 rounded border border-amber-400/20 bg-amber-400/10 px-2.5 py-2 text-[11px] text-amber-100">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onCancel} className="rounded bg-white/10 px-3 py-1.5 text-xs hover:bg-white/20">Cancel</button>
          <button
            onClick={() => void go()}
            disabled={busy || !id.trim()}
            className="rounded bg-violet-500/80 px-3 py-1.5 text-xs font-medium hover:bg-violet-500 disabled:opacity-40"
          >
            {busy ? "Forking…" : "Fork"}
          </button>
        </div>
      </div>
    </div>
  );
}
