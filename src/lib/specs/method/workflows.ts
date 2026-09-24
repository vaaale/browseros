// 049 T00x — workflows: the unit a project binds to (FR-002 … FR-005).
//
// A method is a framework; a WORKFLOW is a named pipeline inside it. Every
// framework already has the concept — OpenSpec keeps `schema: spec-driven` in
// its config and can `schema fork` it, BMAD has modules — so BOS enumerates
// workflows across every installed method and a user names one:
//
//     "create Document Processing using the bmad-enterprise workflow"
//
// A method that declares no workflows has exactly ONE, named for the method.
// That is what keeps every `method: "bmad"` binding working untouched: it
// resolves as "bmad's default workflow" rather than becoming a legacy form to
// migrate.
//
// FRAMEWORK-FREE: pure functions over the registry. No I/O, no server-only.

import { listMethods, getMethod } from "./registry";
import type { MethodDescriptor, WorkflowSpec } from "./types";

/** A workflow together with the method that provides it. */
export interface ResolvedWorkflow {
  /** Bare id, e.g. "enterprise". Unique only within its method. */
  id: string;
  /** Always-unambiguous form, `<methodId>:<id>`. */
  qualified: string;
  label: string;
  description?: string;
  method: MethodDescriptor;
  /** This method's default workflow. */
  isDefault: boolean;
}

export class WorkflowNotFoundError extends Error {
  constructor(name: string, available: string[]) {
    super(
      `Unknown workflow "${name}". Available: ${available.join(", ") || "none"}.` +
        // NEVER fall back to a default here (FR-005). A project silently created
        // under the wrong framework is the exact failure 049 exists to remove,
        // and it is discovered much later, by its artifacts having the wrong
        // names.
        ` Naming a workflow that does not exist is refused rather than defaulted.`,
    );
    this.name = "WorkflowNotFoundError";
  }
}

export class WorkflowAmbiguousError extends Error {
  constructor(name: string, owners: string[]) {
    super(
      `Workflow "${name}" is provided by more than one method (${owners.join(", ")}). ` +
        `Qualify it as "<method>:${name}".`,
    );
    this.name = "WorkflowAmbiguousError";
  }
}

/** Every workflow a descriptor provides. A method declaring none has exactly
 *  one, named for itself — see the module note. */
export function workflowsOf(method: MethodDescriptor): ResolvedWorkflow[] {
  const declared: WorkflowSpec[] = method.workflows?.length
    ? method.workflows
    : [{ id: method.id, label: method.label, default: true }];

  // Exactly one default. If the pack marked none, the first declared is it —
  // silently having no default would make an unqualified method id unresolvable,
  // which is the one form that must never break.
  const explicit = declared.findIndex((w) => w.default);
  const defaultIndex = explicit >= 0 ? explicit : 0;

  return declared.map((w, i) => ({
    id: w.id,
    qualified: `${method.id}:${w.id}`,
    label: w.label ?? w.id,
    description: w.description,
    method,
    isDefault: i === defaultIndex,
  }));
}

/** Every workflow across every installed method. */
export function listWorkflows(): ResolvedWorkflow[] {
  return listMethods().flatMap(workflowsOf);
}

/** The default workflow of a method. */
export function defaultWorkflowOf(method: MethodDescriptor): ResolvedWorkflow {
  const all = workflowsOf(method);
  return all.find((w) => w.isDefault) ?? all[0];
}

/** Resolve a name to exactly one workflow.
 *
 *  Accepts, in order of specificity:
 *    - `<method>:<workflow>`  — always unambiguous
 *    - a bare method id       — that method's DEFAULT workflow, which is how
 *                               every pre-049 `method:` binding keeps working
 *    - a bare workflow id     — when exactly one method provides it
 *
 *  A bare name matching several methods is REPORTED, never decided by
 *  registration order (FR-004) — the same rule 045 FR-001a applies to duplicate
 *  agent ids, and for the same reason: resolving by install order makes "which
 *  one did I get" depend on history nobody can inspect. */
export function resolveWorkflow(name: string): ResolvedWorkflow {
  const wanted = name.trim();
  const all = listWorkflows();
  if (!wanted) throw new WorkflowNotFoundError(name, all.map((w) => w.qualified));

  if (wanted.includes(":")) {
    const hit = all.find((w) => w.qualified === wanted);
    if (!hit) throw new WorkflowNotFoundError(wanted, all.map((w) => w.qualified));
    return hit;
  }

  // A bare METHOD id means that method's default. Checked before the bare
  // workflow lookup so a method whose id collides with another method's
  // workflow name still resolves to itself.
  const asMethod = getMethod(wanted);
  if (asMethod) return defaultWorkflowOf(asMethod);

  const matches = all.filter((w) => w.id === wanted);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new WorkflowNotFoundError(wanted, all.map((w) => w.qualified));
  throw new WorkflowAmbiguousError(wanted, matches.map((w) => w.method.id));
}
