// Framework-free types for the Build Studio spec subsystem. Keep free of Node
// and React imports so it is safe to use on both server and client.

export type PhaseId =
  | "constitution"
  | "specify"
  | "clarify"
  | "plan"
  | "tasks"
  | "analyze"
  | "implement"
  | "converge"
  | "test";

export type PhaseState = "done" | "pending" | "na";

export interface PipelinePhase {
  id: PhaseId;
  state: PhaseState;
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
  /** Set on draft nodes (020): the `bos/*` branch this feature/file lives on.
   *  Draft content is read-only from base; it lands via the feature's promote. */
  branch?: string;
  children?: SpecTreeNode[];
}

/** The known spec-kit artifact file names, in pipeline order. */
export const ARTIFACT_FILES = [
  "spec.md",
  "plan.md",
  "tasks.md",
  "research.md",
  "data-model.md",
  "quickstart.md",
] as const;
