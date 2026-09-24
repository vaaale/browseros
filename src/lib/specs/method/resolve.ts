// 045 T017 — which method a store is bound to (FR-008, FR-008a).
//
// Precedence, most specific first:
//   1. project.json `method`   (per-Project override)
//   2. spec-store.json `method` (per-store binding)
//   3. the global default       (per-USER, not per-deployment — `data/` is a
//      per-user volume under Bastion, so one user's default must not move
//      another's stores; FR-008a)
//   4. "spec-kit"
//
// Absent everywhere ⇒ spec-kit, so nothing changes for an existing store that
// has never heard of this feature. That fallback is what makes SC-001 parity a
// property of real deployments and not just of the test corpus.

import { getMethod, methodPackRoot, registerMethod } from "./registry";
// Not circular: workflows.ts reads the registry, never this module.
import { resolveWorkflow } from "./workflows";
import { builtinPackRoot, loadBuiltinDescriptor } from "./builtin-pack";
import type { MethodDescriptor } from "./types";

export const DEFAULT_METHOD_ID = "spec-kit";

/** Register the built-in descriptor if it is not already present.
 *
 *  Idempotent and safe to call from anywhere. T006a registers at boot so a
 *  cold start is correct, but unit tests and one-off scripts never run
 *  instrumentation — and a missing descriptor there would surface as a store
 *  that renders empty rather than as "you forgot to boot", which is precisely
 *  the diagnosis-hostile failure SC-015 is about. */
export function ensureBuiltinMethod(): void {
  // Present AND usable. Short-circuiting on the descriptor alone was not enough:
  // a descriptor with no PACK ROOT cannot resolve `templates`, `agentsDir` or a
  // phase's instructions, so "registered" would be true while every path that
  // reaches into the pack silently found nothing.
  //
  // Anything may register spec-kit — a test, a fixture, a future caller — and
  // only this function knows where the built-in pack lives. Repairing a rootless
  // registration is therefore its job, and it is idempotent either way.
  if (getMethod(DEFAULT_METHOD_ID) && methodPackRoot(DEFAULT_METHOD_ID)) return;
  // Registered with its pack root, so `templates`/`agentsDir` resolve against
  // the pack rather than against BOS's source tree — the same way an installed
  // pack's do. There is no separate built-in path any more (SC-005).
  registerMethod(loadBuiltinDescriptor(), builtinPackRoot());
}

/** Thrown when a store names a method that is not installed. NEVER silently
 *  fall back to spec-kit here: a store authored under OpenSpec, reinterpreted
 *  through spec-kit's rules, renders confident and wrong (FR-016 / T026). */
/** Where a resolved method id came from. The error below is useless without it:
 *  "Store X is bound to method Y" sends someone to X's manifest, and when the id
 *  actually came from the global default or a project, it is not there. */
export type BindingSource = "project" | "store" | "global default";

export class MethodNotInstalledError extends Error {
  constructor(
    readonly methodId: string,
    readonly storeId: string,
    readonly source: BindingSource = "store",
  ) {
    super(
      source === "store"
        ? `Store "${storeId}" is bound to method "${methodId}", which is not installed.`
        : `Store "${storeId}" resolves to method "${methodId}" via the ${source}, which is not installed. ` +
          `The binding is NOT in this store's manifest — look at the ${source}.`,
    );
  }
}

export interface MethodBinding {
  /** Explicit binding from the store manifest, if any. */
  store?: string;
  /** Explicit binding from a project manifest, if any. */
  project?: string;
  /** The user's global default, if set. */
  globalDefault?: string;
}

/** Resolve a binding to a descriptor. Pure — the caller supplies the manifest
 *  values, so this is testable without a store and has no I/O of its own. */
/** The method providing a workflow name, or undefined if none does.
 *
 *  Kept separate and non-throwing so `resolveMethod` still raises its own
 *  MethodNotInstalledError — which names the BINDING SOURCE, and is the message
 *  someone actually needs when a store will not open. */
function resolveWorkflowMethod(id: string): MethodDescriptor | undefined {
  try {
    return resolveWorkflow(id).method;
  } catch {
    // Unknown or ambiguous — the caller's MethodNotInstalledError says so with
    // the binding source attached, which is more use than either of ours.
    return undefined;
  }
}

export function resolveMethod(binding: MethodBinding, storeId: string): MethodDescriptor {
  ensureBuiltinMethod();
  const id = binding.project ?? binding.store ?? binding.globalDefault ?? DEFAULT_METHOD_ID;
  const source: BindingSource =
    binding.project ? "project" : binding.store ? "store" : "global default";
  // A binding may name a METHOD (`bmad`) or a WORKFLOW — bare (`enterprise`) or
  // qualified (`bmad:enterprise`). `getMethod` alone only ever knew the first,
  // so a store bound to a qualified workflow resolved as "method not installed"
  // and rendered EMPTY, naming a pack that was installed the whole time.
  //
  // resolveWorkflow handles all three forms, and tries a bare method id first,
  // so this stays exact for every binding that already worked.
  const descriptor = getMethod(id) ?? resolveWorkflowMethod(id);
  if (!descriptor) throw new MethodNotInstalledError(id, storeId, source);
  return descriptor;
}
