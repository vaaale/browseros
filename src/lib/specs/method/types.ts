// 045 T003 — the method descriptor (FR-003) and its rule DSL.
//
// A "method" is a spec framework: spec-kit, OpenSpec, BMAD. Everything BOS
// needs to drive one is data in this shape, so a new framework is a marketplace
// item rather than a code change.
//
// FRAMEWORK-FREE BY CONTRACT: no `server-only`, no Node imports. The Build
// Studio client imports these to render a phase strip it did not compute
// (Principle II — the server decides, the client displays). Adding a server
// import here is not a style slip; it breaks the client build.

import type { PhaseState } from "../types";

/** Bumped when the descriptor shape changes incompatibly. A pack declaring an
 *  unsupported version is REFUSED, naming both versions — never defaulted and
 *  loaded anyway, which turns a version mismatch into a silently empty store
 *  (SC-015). */
export const METHOD_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/** Where a file path is resolved from.
 *
 *  `unit`  — relative to the feature/unit directory (spec.md, tasks.md …).
 *  `store` — relative to the store root (discrepancies.md, the constitution).
 *
 *  These are genuinely different roots, not a convenience: `047` FR-006a exists
 *  because "specs" names a unit-level artifact in one framework and a
 *  store-level directory in another. Collapsing them makes that unexpressible. */
export type ArtifactScope = "unit" | "store";

/** Which store a store-scoped read resolves against.
 *
 *  `own`    — the store the unit lives in.
 *  `system` — the system-owned store, whatever its id (spec-kit's constitution
 *             lives there and is read cross-store for EVERY store).
 *  `user`   — the literal `user-specs` store.
 *
 *  `user` is deliberately a distinct case rather than a store id, because
 *  spec-kit's converge reads a hardcoded `user-specs/discrepancies.md` for
 *  features in every store (pipeline.ts:102). FR-006a requires that quirk be
 *  stated explicitly rather than left implicit in code — naming it here is
 *  how it is stated. */
export type StoreRoot = "own" | "system" | "user";

export interface FileRef {
  /** Path relative to the scope's root, e.g. "spec.md" or "discrepancies.md". */
  rel: string;
  /** Defaults to "unit". */
  scope?: ArtifactScope;
  /** Only meaningful when scope is "store". Defaults to "own". */
  roots?: StoreRoot[];
}

export type Predicate =
  /** Always true. A phase whose outcome BOS cannot observe — it depends on a
   *  human judgement or an out-of-band action (FR-004). Pair with `then: "na"`. */
  | { kind: "manual" }
  /** Present in the directory listing. Says nothing about content. */
  | { kind: "exists"; file: FileRef }
  /** Present AND non-empty. Distinct from `exists` on purpose: spec-kit's
   *  `test` reads the file and tests truthiness (pipeline.ts:111-113), so an
   *  empty test-results.md is `na`. Using `exists` there is an off-by-one-file
   *  regression the parity harness is built to catch. */
  | { kind: "nonEmpty"; file: FileRef }
  | { kind: "contains"; file: FileRef; text: string }
  | { kind: "notContains"; file: FileRef; text: string }
  /** Checklist items (`- [ ]` / `- [x]`) in a file.
   *
   *  `quantifier`: "all" — every item ticked; "any" — at least one; "none" —
   *  zero ticked. ALL THREE ARE FALSE WHEN THERE ARE NO ITEMS. That guard is
   *  the whole reason this is a predicate and not a one-liner: spec-kit gives
   *  `na` when tasks.length === 0 (pipeline.ts:108-109), and a vacuously-true
   *  "all done" would flip 9 live features from `na` to `done`. */
  | { kind: "checklist"; file: FileRef; quantifier: "all" | "any" | "none" }
  /** The file mentions this unit's id — spec-kit's converge check. */
  | { kind: "containsUnitId"; file: FileRef }
  /** Another phase resolved to `state` (default "done"). Distinct from a
   *  `requires` edge: this participates in the clause list and yields whatever
   *  the rule says, where an unsatisfied edge yields `blocked`. */
  | { kind: "dependsOn"; phase: string; state?: PhaseState }
  /** Quantify over files matched by a glob, for artifacts whose cardinality is
   *  unknown when the descriptor is written — BMAD's sharded stories, one file
   *  per story. Without this a framework with dynamic artifacts needs code in
   *  the pipeline, which `048` SC-012 forbids. */
  | { kind: "set"; glob: string; scope?: ArtifactScope; quantifier: "any" | "all" | "none"; of: Predicate }
  /** How many files match a glob. Bounds are inclusive; omit either side. */
  | { kind: "count"; glob: string; scope?: ArtifactScope; min?: number; max?: number }
  | { kind: "all"; of: Predicate[] }
  | { kind: "any"; of: Predicate[] }
  | { kind: "not"; of: Predicate };

/** One clause: if `when` holds, the phase resolves to `then`. */
export interface PhaseRule {
  when: Predicate;
  then: PhaseState;
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

export interface PhaseSpec {
  /** Stable id, e.g. "specify". Free-form: there is no compile-time union of
   *  phase names any more (FR-005/SC-003) — that union was the single biggest
   *  reason a new framework needed a code change. */
  id: string;
  /** Display text for the chip. */
  label: string;
  /** Phases that must be `done` before this one is reachable. An unsatisfied
   *  edge yields `blocked`.
   *
   *  Spec-kit declares `requires: []` on ALL NINE and puts its gating in the
   *  clauses instead. That is not an oversight: under the linear edges
   *  PHASE_ORDER suggests, `converge requires implement` flips 120 of 132 live
   *  features `na -> blocked` and `test requires implement` flips 114, because
   *  `implement` is `done` on only 12. With no edges, output is byte-identical
   *  and `blocked` is unreachable under spec-kit (SC-001). */
  requires: string[];
  /** Evaluated IN ORDER, first match wins. Order is semantic, not cosmetic. */
  rules: PhaseRule[];
  /** State when no rule matches and every `requires` edge is satisfied.
   *  Defaults to "pending".
   *
   *  `implement`, `test` and `converge` need an explicit `else: "na"`. A naive
   *  done-else-pending default flips all three from `na` to `pending` on every
   *  existing feature — an unsanctioned change at corpus scale. */
  else?: PhaseState;

  /** Where this phase's INSTRUCTIONS live — the prompt an agent runs for this
   *  step — as a path relative to the pack root (051 FR-021).
   *
   *  DECLARED, never inferred. spec-kit happens to ship
   *  `templates/commands/<phase-id>.md`, and matching on that convention would be
   *  BOS guessing at pack internals — the exact thing this feature's split exists
   *  to prevent. A pack that organises its prompts differently must work, and a
   *  pack that ships none must be able to say so by omission.
   *
   *  The FILE is the pack's. A user's edit is written to the pack overlay
   *  (`data/method-packs/<id>/`, 048) at the same relative path, so it survives
   *  upgrade, uninstall and reinstall without forking anything. */
  instructions?: string;

  /** The SKILLS that perform this phase (048 FR-028).
   *
   *  `instructions` above points at a FILE, which fits spec-kit — one command
   *  file per phase — and does not fit BMAD, where a phase is performed by a
   *  SKILL: a directory carrying a prompt, templates, references and its own
   *  declared customisation surface. With only `instructions`, the inspector
   *  reported "this pack declares no prompts" for all ten BMAD phases while
   *  `bmad-prd` alone held eight files of exactly what the user was asking for.
   *
   *  A LIST, because a phase legitimately has more than one: BMAD's `brief` can
   *  be done by `bmad-product-brief` or `bmad-prfaq` ("alternatives, never
   *  both"), and three phases have an upstream skill and a BOS-specific one.
   *  Collapsing that to a single id would force the pack to hide one of them.
   *
   *  DECLARED, never inferred from a naming convention — the same rule as
   *  `instructions`. The mapping existed in BMAD's driver skill as a prose
   *  table, readable by an agent and invisible to every surface. */
  skills?: string[];

  /** This phase may legitimately be SKIPPED — the pipeline is complete without
   *  it (051).
   *
   *  Declarative only: it changes no state. `else: "na"` already produces the
   *  right state for a phase nobody has done, and this says WHY that `na` is
   *  there — "not needed here" rather than "not reached yet". Those are
   *  indistinguishable today, which costs in two places:
   *
   *    - a DRIVER cannot tell which steps it may pass over, so it either marches
   *      through everything or guesses;
   *    - a READER cannot tell an optional step from an unfinished one.
   *
   *  Data rather than behaviour, for the same reason as everything else a pack
   *  declares: BOS renders and reports it, and never decides it. */
  optional?: boolean;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export interface SectionSpec {
  /** Path from the store root; "" is the store root itself. */
  rel: string;
  /** What this part of the store holds.
   *  `active`  — work in progress (spec-kit's features, OpenSpec's changes).
   *  `truth`   — the current agreed state (OpenSpec's specs/).
   *  `archive` — completed and frozen. */
  kind: "active" | "truth" | "archive";
  /** A directory is a unit leaf iff it DIRECTLY contains this file. One rule,
   *  one place — `pipeline.ts` had four copies of it (SC-004). */
  leafMarker: string;
  /** "nnn-slug" allocates NNN- prefixes; "none" skips allocation entirely. */
  numbering: "nnn-slug" | "none";
  /** Units here are finished: render a terminal state instead of evaluating
   *  the phase DAG. An archived OpenSpec change must not display
   *  "tasks: available" for work completed months ago (`047` FR-006b/SC-004). */
  terminal?: boolean;
  /** Terminal label, when `terminal`. Defaults to "Archived". */
  terminalLabel?: string;
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

/** A selectable sub-bundle of a pack, contributing agents and workflows.
 *
 *  Mirrors BMAD's own installer, which offers `bmm` (selected, needs config),
 *  `bmb` and `cis` (neither selected by default). */
export interface ModuleSpec {
  id: string;
  label?: string;
  /** Selected by default at install. */
  default?: boolean;
  /** Needs configuration before it can run — surfaced at install time. */
  requiresConfig?: boolean;
  /** Agents directory, relative to the PACK root. Defaults to
   *  `modules/<id>/agents`. */
  agentsDir?: string;
  /** Where this module's agents appear. Per MODULE, not per pack (048 FR-007):
   *  BMM's cast is chain-dependent and belongs behind `agent_delegate`, while
   *  CIS's facilitators and BMB's builder are things a user talks to directly. */
  visibility?: "picker" | "delegate-only";
}

/** Normalise the compatible union to objects. A bare string is a 045-era
 *  descriptor's module, which had no properties beyond its id and was always
 *  active — hence `default: true`. */
export function normalizeModules(modules: MethodDescriptor["modules"]): ModuleSpec[] {
  return (modules ?? []).map((m) => (typeof m === "string" ? { id: m, default: true } : m));
}

export interface ArtifactSpec {
  /** File name relative to its scope, e.g. "spec.md". */
  id: string;
  /** The phase that produces it. */
  generates?: string;
  /** Artifacts that must exist first. */
  requires?: string[];
  scope?: ArtifactScope;
}

// ---------------------------------------------------------------------------
// The descriptor
// ---------------------------------------------------------------------------

/** A named pipeline within a method (049 FR-002, FR-003).
 *
 *  The unit a project binds to. Every framework already has this concept under
 *  its own name — OpenSpec stores `schema: spec-driven` in its config and can
 *  `schema fork` it, BMAD has modules — so "a pack provides workflows and you
 *  bind one" is the shape the tools already use. A method declaring none has
 *  exactly one, named for the method itself, which is what keeps every existing
 *  `method`-keyed binding working unchanged. */
export interface WorkflowSpec {
  /** Unique within its pack. Addressed bare when unambiguous across all
   *  installed packs, or as `<methodId>:<id>` when not. */
  id: string;
  label?: string;
  description?: string;
  /** The default for its method. Exactly one per pack; the first declared wins
   *  if none is marked. */
  default?: boolean;
}

/** What a Project's directory contains under this method (049 FR-007).
 *
 *  DATA, never code. 045's premise is that a framework is a marketplace item
 *  rather than a code change, and FR-013a gates executable content from a
 *  marketplace behind a per-origin opt-in — so standardising on pack-registered
 *  handlers would push every pack through that gate or route around it. Nothing
 *  about creating a directory needs code. */
export interface ProjectScaffold {
  /** The file that MARKS a project. Defaults to `project.json`. */
  manifest?: string;
  /** Directories to create, relative to the project root. */
  dirs?: string[];
  /** Files to write, each from a template in the pack's templates directory. */
  files?: Array<{ path: string; template: string }>;
}

/** What a pack installs into the repository a store lives in (048 FR-026). */
export interface ProjectRuntimeSpec {
  /** Directory created at the project root, e.g. `_bmad`. One directory, so the
   *  footprint in someone else's repository is a single reviewable entry. */
  dir: string;
  /** Pack-relative source copied into it. */
  from: string;
  /** Paths under `dir` that belong to the USER once created, and are never
   *  overwritten by a later install or upgrade — BMAD's `custom/` holds
   *  committed team overrides, and refreshing the runtime must not touch them.
   *
   *  Without this the upgrade path silently reverts a team's customisations,
   *  which is the failure mode 048 FR-005 exists to prevent one level up. */
  preserve?: string[];
}

export interface MethodDescriptor {
  schemaVersion: number;
  id: string;
  label: string;
  version: string;
  /** Ships with BOS rather than being installed. Carries NO privileges — the
   *  built-in descriptor is expressed in exactly this shape and evaluated by
   *  exactly the same code path (SC-002 greps for `builtin` branches in the
   *  pipeline). It exists so the UI can say "built in" and so uninstall can
   *  refuse. */
  builtin?: boolean;

  sections: SectionSpec[];

  /** Constitution path, relative to `constitutionRoot`. */
  constitution: string;
  /** Which store the constitution is read from.
   *
   *  spec-kit uses "system": ONE constitution in the system store, read for
   *  every store including item-owned ones. Resolving it per-store instead
   *  flips all 8 item stores `done -> pending` — which is the entire reason
   *  this field exists rather than being assumed (FR-006b). */
  constitutionRoot: StoreRoot;

  /** Where drift is recorded, and which stores are concatenated when reading
   *  it. spec-kit reads the system store's frozen copy AND a hardcoded
   *  `user-specs/discrepancies.md`, for features in every store — stated here
   *  rather than buried in code, per FR-006a's explicit-exception clause. */
  discrepancies: { rel: string; roots: StoreRoot[] };

  /** Convention for a unit's e2e test file, e.g. "e2e/<unit-id>.spec.ts".
   *  `<unit-id>` is substituted (`046` FR-014). */
  testFile?: string;

  artifacts: ArtifactSpec[];

  /** Display order for a unit's artifacts. SEPARATE from `artifacts[]` on
   *  purpose: spec-kit's ARTIFACT_FILES omits design.md and test-results.md,
   *  so both fall to a `99 -> localeCompare` tail. 23 live features carry a
   *  design.md, and re-ranking it changes Specification.artifacts[], which
   *  SC-001 requires be identical. Names absent from this list sort after
   *  everything in it, alphabetically. */
  artifactOrder: string[];

  phases: PhaseSpec[];

  /** Per-state display text. `047` renames `pending` to "Available" without
   *  renaming the STATE — the state ids stay fixed so parity is expressible
   *  and the pipeline stays framework-agnostic (design.md §3.5). */
  stateLabels: Record<PhaseState, string>;

  /** Named pipelines this method provides (049). Absent means exactly one,
   *  named for the method — so `method: "bmad"` keeps resolving as "bmad's
   *  default workflow" with no migration. */
  workflows?: WorkflowSpec[];

  /** What a Project looks like under this method (049 FR-007). Absent means a
   *  manifest-only project, which is what spec-kit and BMAD want. */
  project?: ProjectScaffold;

  /** Templates directory, relative to the pack root. Mounted at
   *  /Methods/<id>/templates.
   *
   *  OPTIONAL, so a pack that ships no templates says so by OMISSION — the same
   *  rule as `PhaseSpec.instructions`. It used to be required, which made a pack
   *  that HAD no templates indistinguishable from one that forgot to write them,
   *  and BMAD was in exactly that state: it declared `"templates": "templates"`,
   *  shipped no such directory, and told five of its phases to author against
   *  the mount. Git hid the omission completely — an empty directory cannot be
   *  committed, so there was no gap in the file list and no deletion in the log.
   *
   *  Declared-but-absent is now a REPORTED condition at install (see
   *  `missingTemplatesDir`), because the two states mean different things and
   *  only one of them is a mistake. */
  templates?: string;

  /** Where this method's specs live inside an ARBITRARY repository (050 FR-003).
   *
   *  One path segment, relative to the repo root — `openspec` for OpenSpec,
   *  because that framework's own CLI must keep working on the same checkout.
   *  BOS does not invent a location: a repo is the user's, and putting specs
   *  somewhere the framework cannot find them breaks the round trip that makes
   *  adopting a framework worthwhile.
   *
   *  This bounds the SPEC STORE, not BOS: ordinary development writes go
   *  anywhere in the repo, because driving a pipeline over an application you
   *  cannot edit is pointless.
   *
   *  REQUIRED, and `"."` means the repo root — a framework that writes `PRD.md`
   *  beside the code says so explicitly. It used to be optional with "absent ⇒
   *  repo root" as the default, which made a pack that FORGOT the field
   *  indistinguishable from one that meant the root. Two shipped packs (bmad,
   *  openspec) omitted it for a while and the only symptom was silence:
   *  `detectMethod` skips a pack with no storeRoot, so a repository already
   *  using OpenSpec was never offered OpenSpec, and registering with either pack
   *  put the store at the repo root instead of `docs/` or `openspec/`.
   *  `registerMethod` now refuses a descriptor without it, naming the pack. */
  storeRoot: string;

  /** Files a pack needs INSIDE THE USER'S REPOSITORY to work at all (048 FR-026).
   *
   *  BMAD is the case this exists for: 75 of its skill files shell out to
   *  `{project-root}/_bmad/scripts/*.py`, and its own `_bmad/custom/<skill>.toml`
   *  is where a team's committed customisations live. Neither can sit in BOS's
   *  `data/` — `{project-root}` is where `npx bmad-method install` puts them, so
   *  BMAD's own CLI keeps working on the same checkout, and a team override is
   *  committed with the code it describes.
   *
   *  DECLARED, never inferred. BOS writing into a user's repository is a
   *  significant act; it happens because a pack asked for it, by name, and is
   *  reported when it does. A pack that needs nothing declares nothing and BOS
   *  touches no repository on its behalf.
   *
   *  `{project-root}` resolves to the store's `repoRoot` (050). */
  projectRuntime?: ProjectRuntimeSpec;

  /** Skills this pack ships that AUTHOR new pack content (048 FR-029).
   *
   *  BMAD's `bmad-agent-builder` and `bmad-workflow-builder` build a new agent or
   *  skill through conversational discovery. Declaring them lets BOS point at
   *  them where authoring happens — a phase with no skill on an editable
   *  workflow — instead of leaving the user with an empty step and no route to
   *  filling it.
   *
   *  BOS does not RUN them: they are skills, the agent already has them, and
   *  building a second invocation path would be a mechanism competing with the
   *  one that exists. BOS names them and says what to ask for. */
  builders?: string[];

  /** The skill that teaches an agent how to RUN this method's pipeline.
   *
   *  Declared, never inferred from a naming convention: a convention breaks
   *  silently when a pack picks another name, and there is nothing to report.
   *  Declared, a missing driver is caught at install like a dangling role
   *  (`046` FR-021).
   *
   *  This is what keeps per-method knowledge inside the pack. Without it the
   *  agent has to reconstruct a pipeline the descriptor already states — from
   *  step skills, or worse from the pack's own SPEC, which describes how the
   *  pack was BUILT rather than how to use it. */
  driverSkill?: string;

  /** Agent ids this pack contributes. */
  agents: string[];
  /** Role -> agent id. Lets a pack say who plays "architect" without BOS
   *  hardcoding a cast. */
  roles: Record<string, string>;
  /** Optional sub-modules (BMAD's expansion packs).
   *
   *  BACKWARD COMPATIBLE, NOT a schemaVersion bump (048 FR-006a). 045 shipped
   *  `string[]`; 048 needs per-module defaults, config requirements, agent
   *  directories and visibility. Bumping METHOD_SCHEMA_VERSION to 2 would make
   *  registerMethod REFUSE every existing pack — spec-kit's own method.json
   *  included, since it refuses on mismatch by design and with no silent
   *  defaulting — a breaking change for a purely additive field. Reserve the
   *  bump for something that genuinely cannot be expressed compatibly.
   *
   *  A bare string normalises to `{ id, default: true }` (see normalizeModules). */
  modules?: Array<string | ModuleSpec>;
}

/** The slice of a descriptor the Build Studio CLIENT needs (FR-014 / T028).
 *
 *  A projection rather than the whole descriptor: the client renders phases and
 *  names states, and shipping the rule DSL to the browser would invite someone
 *  to evaluate it there — which is exactly the server-authority split
 *  (Principle II) this feature is built around. */
export interface MethodSummary {
  id: string;
  label: string;
  version: string;
  builtin?: boolean;
  stateLabels: Record<PhaseState, string>;
  sections: SectionSpec[];
  /** Where this method writes specs inside a repository — see `storeRoot` above.
   *
   *  Summarised because it is the field that decides what BOS does to the user's
   *  own source tree, and it was not observable from outside the process at all:
   *  when two packs shipped without it, nothing on any page or endpoint could
   *  have shown that. A field that changes where files land has to be visible to
   *  whoever is asked to trust it. */
  storeRoot: string;
}

export function toMethodSummary(d: MethodDescriptor): MethodSummary {
  return {
    id: d.id,
    label: d.label,
    version: d.version,
    builtin: d.builtin,
    stateLabels: d.stateLabels,
    sections: d.sections,
    storeRoot: d.storeRoot,
  };
}
