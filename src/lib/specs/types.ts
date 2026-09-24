// Framework-free types for the Build Studio spec subsystem. Keep free of Node
// and React imports so it is safe to use on both server and client.

/** A phase id. Free-form since 045: the compile-time union that used to live
 *  here named spec-kit's nine phases, which meant every new framework needed a
 *  code change to add one (FR-005/SC-003). Phase ids now come from the active
 *  method descriptor. */
export type PhaseId = string;

/** `blocked` (045): a `requires` edge in the descriptor's phase DAG is
 *  unsatisfied, so the phase is not merely un-started but unreachable. Kept
 *  DISTINCT from `na`, which means "does not apply here at all".
 *
 *  `pending` is retained rather than renamed. 047 displays it as "Available",
 *  but it does so through the descriptor's `stateLabels` — renaming the STATE
 *  would make SC-001 parity inexpressible by construction (design.md §3.4). */
export type PhaseState = "done" | "pending" | "blocked" | "na";

export interface PipelinePhase {
  id: PhaseId;
  state: PhaseState;
  /** Display text from the descriptor. The only field 045 adds to this shape,
   *  and the only permitted addition under SC-001. */
  label?: string;
}

export interface Task {
  /** e.g. "T001". May be empty for un-numbered checklist items. */
  id: string;
  text: string;
  done: boolean;
}

export interface Artifact {
  /** File name, e.g. "spec.md". */
  name: string;
  /** specs-relative path, e.g. "001-build-studio/spec.md". */
  path: string;
}

export interface Specification {
  /** Path from the store root to the feature leaf — a Project id, any plain
   *  organizational sub-folders, and the NNN-slug, e.g. "bos/001-build-studio"
   *  or "bos/agent-loop/003-foo" (033-project-layer). Numbering resets per
   *  project, so this full relative path — never a bare NNN-slug — is the
   *  thing that's unique within a store; use it (or `.path`) as the key. */
  id: string;
  /** The spec store this feature lives in (its directory id under the container root). */
  store: string;
  /** Derived from spec.md's H1 or the folder name. */
  title: string;
  /** Store-prefixed path, e.g. "bos-system-specs/bos/001-build-studio". */
  path: string;
  artifacts: Artifact[];
  phases: PipelinePhase[];
  taskProgress?: { done: number; total: number };
  /** Set when this specification only reflects a draft `bos/*` branch (020) —
   *  mirrors SpecTreeNode's `branch`. Absent for a base-store specification. */
  branch?: string;
}

export type StoreOwner = "system" | "user" | "marketplace" | "item";

export interface SpecTreeNode {
  /** "project" (033) = a store's top-level, `project.json`-bearing grouping
   *  folder. "dir" = a plain organizational sub-folder below a project, no
   *  metadata of its own. "feature" = a leaf directory that directly contains
   *  spec.md, at any depth under a project. */
  type: "group" | "project" | "feature" | "file" | "dir";
  name: string;
  /** Store-prefixed path (e.g. "bos-system-specs/bos/001-build-studio/spec.md"); a group's path is its store id. */
  path: string;
  /** For a "group" node: the store's human label + policy flags. For a
   *  "project" node: its project.json label. */
  label?: string;
  /** For a "project" node: its project.json description, if any. */
  description?: string;
  owner?: StoreOwner;
  writable?: boolean;
  requiresPromote?: boolean;
  /** For an "item"-owned group: where the item came from — "local" or the
   *  marketplace's display name — so the UI can show it without a second
   *  round-trip. Absent for non-item groups. */
  originLabel?: string;
  /** Set on a "group" node whose store names a method that is not installed
   *  (046/045 FR-016). The group still renders, carrying the method id, so the
   *  cause is visible — a store that simply vanishes reads as data loss. */
  methodMissing?: string;
  /** 045 FR-008/FR-009 — the method this node RESOLVES to, on "group" and
   *  "project" nodes.
   *
   *  Per node, not per app: the binding chain is project > store > global
   *  default, so two groups in one tree legitimately differ. The UI previously
   *  rendered a single app-level `activeMethodSummary()` — hardcoded to
   *  user-specs — as every store's dropdown value, so binding any OTHER store
   *  left its picker showing user-specs' method. Resolving per node server-side
   *  keeps the displayed binding and the binding BOS actually applies the same
   *  value by construction, rather than two reads that can drift. */
  method?: string;
  /** True when THIS node declares the binding above, false when it inherits.
   *  An inherited binding must not be presented as a decision made here — the
   *  user needs to know whether clearing it changes anything. */
  methodBound?: boolean;
  /** 049 FR-011 — set on a "group" node: where a workflow may be bound in this
   *  store, and what a "project" IS here. Server-computed from the store's KIND
   *  so the tree offers only actions that can take effect — the per-Project
   *  picker was previously rendered in stores that never honour one. */
  bindingScope?: "none" | "store" | "project";
  projectUnit?: "none" | "folders" | "items";
  /** 047 US4/FR-006 — set on a node that IS a declared section root. Three
   *  sections with different meanings render in one tree, and `specs/` (current
   *  truth) is not a peer of `changes/` (a proposal): without a visible
   *  distinction a user edits current truth believing they are editing a
   *  proposal, which is a correctness problem, not a cosmetic one. */
  sectionKind?: "active" | "truth" | "archive";
  /** Set alongside `sectionKind` when that section is frozen. Its units render a
   *  terminal state rather than live phase state. */
  terminal?: boolean;
  /** Set on draft nodes (020): the `bos/*` branch this feature/file lives on.
   *  Draft content is read-only from base; it lands via the feature's promote. */
  branch?: string;
  /** Set on an item store's row: the feature branch its artifacts were actually
   *  READ THROUGH. Not a draft graft — this is the live, writable coupled
   *  worktree, the same place writes go, so it is deliberately NOT `branch`
   *  (which means "read-only preview of someone else's draft").
   *
   *  It exists because nothing said so. A marketplace change branches user-apps
   *  and only user-apps, every OTHER store showed a branch badge, and the one
   *  store the work was actually happening in showed none — reading, correctly,
   *  as "my branch went everywhere except where I wanted it". */
  liveBranch?: string;
  /** Set on an item store's row when the active branch does NOT couple
   *  user-apps, carrying why. The row then shows base content: truthful, and
   *  the alternative is an empty store or a failed tree. */
  offBranch?: string;
  children?: SpecTreeNode[];
}

// 045 T007 deleted ARTIFACT_FILES from here. It hardcoded spec-kit's artifact
// names as THE artifact names, and its only consumer was byArtifactOrder.
// Display order now comes from the active descriptor's `artifactOrder` — see
// seed/method-packs/spec-kit/method.json, which reproduces this exact list including
// its OMISSIONS: design.md and test-results.md were never in it, so both fall
// to a `99 -> localeCompare` tail that 23 live features depend on.
