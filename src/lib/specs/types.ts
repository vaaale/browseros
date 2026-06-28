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
  | "converge";

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
  /** Derived from spec.md's H1 or the folder name. */
  title: string;
  /** specs-relative path, e.g. "001-build-studio". */
  path: string;
  artifacts: Artifact[];
  phases: PipelinePhase[];
  taskProgress?: { done: number; total: number };
}

export interface SpecTreeNode {
  type: "feature" | "file" | "dir";
  name: string;
  /** specs-relative path. */
  path: string;
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
