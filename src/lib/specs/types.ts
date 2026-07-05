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
  /** Feature folder name, e.g. "001-build-studio". */
  id: string;
  /** The spec store this feature lives in (its directory id under the container root). */
  store: string;
  /** Derived from spec.md's H1 or the folder name. */
  title: string;
  /** Store-prefixed path, e.g. "bos-system-specs/001-build-studio". */
  path: string;
  artifacts: Artifact[];
  phases: PipelinePhase[];
  taskProgress?: { done: number; total: number };
}

export type StoreOwner = "system" | "user" | "marketplace";

export interface SpecTreeNode {
  type: "group" | "feature" | "file" | "dir";
  name: string;
  /** Store-prefixed path (e.g. "bos-system-specs/001-build-studio/spec.md"); a group's path is its store id. */
  path: string;
  /** For a "group" node: the store's human label + policy flags. */
  label?: string;
  owner?: StoreOwner;
  writable?: boolean;
  requiresPromote?: boolean;
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
