// 045 T004 — the rule evaluator (FR-004, FR-004a).
//
// Resolves a descriptor's phases against one unit (a feature/change/story).
// Pure over an INJECTED reader — no `fs`, no `server-only` — so it is unit
// testable without a spec store, and so the same code evaluates a built-in
// descriptor and a marketplace pack's.
//
// PHASE STATE IS AN ORDERED CLAUSE LIST, NOT A BOOLEAN (design.md §3.4). Each
// phase declares `rules[]` evaluated in order, first match wins; if none
// matches, the phase is `blocked` when a `requires` edge is unsatisfied, else
// its `else` (default `pending`).
//
// That shape is forced, not chosen. A naive done-else-pending-else-blocked
// rule flips three phases from `na` to `pending` on EVERY existing feature:
// `implement` with a tasks.md and 0 done, `test` with no results file, and
// `converge` with no discrepancy entry — which is never `pending` today. That
// is an unsanctioned change at corpus scale, and it would only have surfaced
// at T011, after the pipeline refactor had already landed.

import type { PhaseState, PipelinePhase } from "../types";
import { parseTasks } from "../tasks";
import type { ArtifactScope, MethodDescriptor, PhaseSpec, Predicate, StoreRoot } from "./types";

/** Everything the evaluator is allowed to know about a unit. Injected, so the
 *  evaluator never touches a filesystem or a store. */
export interface EvalUnit {
  /** The unit's id — what `containsUnitId` searches for. */
  unitId: string;
  /** File names directly in the unit's directory. `exists` is a listing check,
   *  deliberately distinct from reading (see `nonEmpty`). */
  names: string[];
  /** Unit-scoped read. Returns "" when absent — absence and emptiness are the
   *  same to every predicate except `exists`, which uses `names`. */
  readUnit(rel: string): Promise<string>;
  /** Store-scoped read, concatenating `roots` in order. */
  readStore(rel: string, roots: StoreRoot[]): Promise<string>;
  /** Paths matching a glob within a scope. Only needed by `set`/`count`. */
  /** REQUIRED, not optional. It was optional so a caller could omit it, and the
   *  fallback below matched the unit's TOP-LEVEL names instead — which every
   *  nested glob misses, silently. The only production caller always supplies
   *  it; the only callers that did not were TESTS, which then exercised a
   *  configuration the product never produces and passed while `set`/`count`
   *  matched nothing for every shipped pack.
   *
   *  Required turns that from a silent wrong answer into a compile error. */
  glob(pattern: string, scope: ArtifactScope): Promise<string[]>;
}

/** Translate a glob to a RegExp. Supports `**` (any depth), `*` (one segment)
 *  and `?`. Deliberately small: these match artifact paths inside one unit, not
 *  arbitrary user input. */
/** Does `path` match `pattern`? Exported so the pipeline's glob provider and
 *  the evaluator's own fallback can never disagree about what `**` means. */
export function globMatches(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path);
}

function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // `**/` also matches zero directories
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

async function matchGlob(unit: EvalUnit, pattern: string, scope: ArtifactScope): Promise<string[]> {
  return unit.glob(pattern, scope);
}

async function readRef(unit: EvalUnit, file: { rel: string; scope?: ArtifactScope; roots?: StoreRoot[] }): Promise<string> {
  return file.scope === "store" ? unit.readStore(file.rel, file.roots ?? ["own"]) : unit.readUnit(file.rel);
}

/** Evaluate one predicate. `resolve` resolves another phase's state, for
 *  `dependsOn`; it throws on a cycle rather than returning a guess. */
async function test(p: Predicate, unit: EvalUnit, resolve: (phaseId: string) => Promise<PhaseState>): Promise<boolean> {
  switch (p.kind) {
    case "manual":
      return true;
    case "exists":
      // Listing presence only. A store-scoped `exists` has no listing to
      // consult, so it degrades to a non-empty read — the only observable
      // that exists at that scope.
      return p.file.scope === "store" ? (await readRef(unit, p.file)).length > 0 : unit.names.includes(p.file.rel);
    case "nonEmpty":
      return (await readRef(unit, p.file)).length > 0;
    case "contains":
      return (await readRef(unit, p.file)).includes(p.text);
    case "notContains":
      return !(await readRef(unit, p.file)).includes(p.text);
    case "checklist": {
      const items = parseTasks(await readRef(unit, p.file));
      // EVERY quantifier is false on an empty list. spec-kit yields `na` when
      // there are no items (pipeline.ts:108-109); a vacuously-true "all done"
      // would report `done` for the 9 live features whose tasks.md has no
      // parseable items — this feature's own tasks.md included.
      if (items.length === 0) return false;
      const done = items.filter((t) => t.done).length;
      if (p.quantifier === "all") return done === items.length;
      if (p.quantifier === "any") return done > 0;
      return done === 0;
    }
    case "containsUnitId":
      return (await readRef(unit, p.file)).includes(unit.unitId);
    case "dependsOn":
      return (await resolve(p.phase)) === (p.state ?? "done");
    case "set": {
      const files = await matchGlob(unit, p.glob, p.scope ?? "unit");
      // Consistent with `checklist`: a quantifier over nothing is false, so a
      // framework with zero sharded stories does not read as "all complete".
      if (files.length === 0) return false;
      const results = await Promise.all(
        files.map((f) => test(withFile(p.of, f, p.scope ?? "unit"), unit, resolve)),
      );
      if (p.quantifier === "all") return results.every(Boolean);
      if (p.quantifier === "any") return results.some(Boolean);
      return !results.some(Boolean);
    }
    case "count": {
      const n = (await matchGlob(unit, p.glob, p.scope ?? "unit")).length;
      return (p.min === undefined || n >= p.min) && (p.max === undefined || n <= p.max);
    }
    case "all": {
      for (const q of p.of) if (!(await test(q, unit, resolve))) return false;
      return true;
    }
    case "any": {
      for (const q of p.of) if (await test(q, unit, resolve)) return true;
      return false;
    }
    case "not":
      return !(await test(p.of, unit, resolve));
  }
}

/** Rebind a file-bearing predicate onto a specific path, so `set` can apply its
 *  inner predicate to each glob match. A predicate with no file is returned
 *  unchanged — `set { of: { kind: "manual" } }` degenerates to a count. */
function withFile(p: Predicate, rel: string, scope: ArtifactScope): Predicate {
  switch (p.kind) {
    case "exists":
    case "nonEmpty":
    case "containsUnitId":
      return { ...p, file: { ...p.file, rel, scope } };
    case "contains":
    case "notContains":
      return { ...p, file: { ...p.file, rel, scope } };
    case "checklist":
      return { ...p, file: { ...p.file, rel, scope } };
    default:
      return p;
  }
}

/** Resolve every phase in the descriptor for one unit. */
export async function evaluatePhases(descriptor: MethodDescriptor, unit: EvalUnit): Promise<PipelinePhase[]> {
  const byId = new Map<string, PhaseSpec>(descriptor.phases.map((p) => [p.id, p]));
  const memo = new Map<string, PhaseState>();
  const inFlight = new Set<string>();

  async function resolve(phaseId: string): Promise<PhaseState> {
    const cached = memo.get(phaseId);
    if (cached) return cached;
    const phase = byId.get(phaseId);
    // A rule naming a phase that does not exist is an authoring error in the
    // pack, not a runtime condition to paper over. Treating it as `na` would
    // make a typo in a descriptor look like a deliberate "not applicable".
    if (!phase) throw new Error(`Method "${descriptor.id}": phase "${phaseId}" is referenced but not declared.`);
    if (inFlight.has(phaseId)) {
      throw new Error(`Method "${descriptor.id}": cyclic phase dependency involving "${phaseId}".`);
    }
    inFlight.add(phaseId);
    try {
      let state: PhaseState | undefined;
      for (const rule of phase.rules) {
        if (await test(rule.when, unit, resolve)) {
          state = rule.then;
          break;
        }
      }
      if (state === undefined) {
        // Edges are consulted ONLY when no clause matched. A phase whose
        // artifact demonstrably exists reports on that evidence rather than on
        // its predecessors' state.
        let blocked = false;
        for (const req of phase.requires) {
          if ((await resolve(req)) !== "done") {
            blocked = true;
            break;
          }
        }
        state = blocked ? "blocked" : (phase.else ?? "pending");
      }
      memo.set(phaseId, state);
      return state;
    } finally {
      inFlight.delete(phaseId);
    }
  }

  const out: PipelinePhase[] = [];
  for (const phase of descriptor.phases) {
    out.push({ id: phase.id, state: await resolve(phase.id), label: phase.label });
  }
  return out;
}
