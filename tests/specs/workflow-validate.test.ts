// 051 T023 — the structural validator, and the guard that keeps it honest.
//
// The first test is the important one: EVERY PACK BOS SHIPS MUST VALIDATE CLEAN.
// A validator for user edits is easy to make too strict, and the way that fails
// is invisible — the rule looks sensible, nobody runs it against the real
// descriptors, and the default method turns out to be "invalid". Two candidate
// rules were dropped for exactly this reason (see validate.ts).
//
//   npm run test:unit -- tests/specs/workflow-validate.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { validateDescriptor } from "../../src/lib/specs/method/validate";
import { loadBuiltinDescriptor } from "../../src/lib/specs/method/builtin-pack";
import type { MethodDescriptor } from "../../src/lib/specs/method/types";

const SPEC_KIT = loadBuiltinDescriptor() as MethodDescriptor;

/** Same loader as workflow-graph.test.ts: absent is a real state on a fresh
 *  checkout, and it must SKIP LOUDLY rather than pass over an unread file. */
function marketplacePack(id: string): MethodDescriptor | null {
  for (const base of [
    join(process.cwd(), "data", "user-apps", "items", id, "method", "method.json"),
    join(process.cwd(), "..", "bos-marketplace", "items", id, "method", "method.json"),
  ]) {
    if (existsSync(base)) return JSON.parse(readFileSync(base, "utf8")) as MethodDescriptor;
  }
  return null;
}

/** A descriptor with the required scaffolding, so a test can state only the
 *  thing it is about. */
function descriptor(over: Partial<MethodDescriptor>): MethodDescriptor {
  return {
    schemaVersion: 1,
    id: "t",
    label: "T",
    version: "1.0.0",
    sections: [{ rel: "", kind: "active", leafMarker: "spec.md", numbering: "nnn-slug" }],
    constitution: "c.md",
    constitutionRoot: "system",
    discrepancies: { rel: "d.md", roots: ["system"] },
    artifacts: [],
    artifactOrder: [],
    phases: [],
    stateLabels: { done: "Done", pending: "Available", blocked: "Blocked", na: "N/A" },
    templates: "templates",
    storeRoot: ".",
    agents: [],
    roles: {},
    ...over,
  };
}

const phase = (id: string, over: Partial<MethodDescriptor["phases"][number]> = {}) => ({
  id, label: id, requires: [], rules: [], ...over,
});

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

test("spec-kit — the DEFAULT method — validates clean", () => {
  expect(validateDescriptor(SPEC_KIT)).toEqual([]);
});

test("spec-kit's three ungenerated artifacts are NOT a problem", () => {
  // research.md, data-model.md and quickstart.md have no `generates`. A rule
  // requiring every artifact to have a producer would flag the default method.
  const orphans = SPEC_KIT.artifacts.filter((a) => !a.generates).map((a) => a.id);
  expect(orphans, "measured, not assumed — if a pack edit changes this the test says so")
    .toEqual(["research.md", "data-model.md", "quickstart.md"]);
  expect(validateDescriptor(SPEC_KIT).filter((p) => p.code === "unknown-generates")).toEqual([]);
});

test("spec-kit's zero gates are NOT a problem", () => {
  // Every phase is "unreachable" under a reachability rule, because there are no
  // gates to reach along. Isolation is reported by graph.ts as a diagnostic.
  expect(SPEC_KIT.phases.filter((p) => p.requires.length)).toEqual([]);
  expect(validateDescriptor(SPEC_KIT)).toEqual([]);
});

for (const id of ["bmad", "openspec"]) {
  test(`${id} validates clean`, () => {
    const pack = marketplacePack(id);
    test.skip(pack === null, `${id} is not installed — clone bos-marketplace to exercise this`);
    expect(validateDescriptor(pack as MethodDescriptor)).toEqual([]);
  });
}

// ---------------------------------------------------------------------------
// What it does catch
// ---------------------------------------------------------------------------

test("a requires edge naming a phase that does not exist", () => {
  const problems = validateDescriptor(descriptor({ phases: [phase("a", { requires: ["ghost"] })] }));
  expect(problems).toHaveLength(1);
  expect(problems[0].code).toBe("unknown-phase");
  expect(problems[0].phase).toBe("a");
  expect(problems[0].message, "names the missing phase, not just the rule").toContain('"ghost"');
});

test("a dependsOn naming a phase that does not exist — the SAME runtime throw, via the rules", () => {
  const problems = validateDescriptor(descriptor({
    phases: [phase("a", { rules: [{ when: { kind: "dependsOn", phase: "ghost" }, then: "done" }] })],
  }));
  expect(problems.map((p) => p.code)).toEqual(["unknown-depends-on"]);
});

test("a dependsOn nested inside all/any/not is still found", () => {
  // The reason validate.ts walks structurally instead of switching on `kind`.
  const problems = validateDescriptor(descriptor({
    phases: [phase("a", {
      rules: [{
        when: { kind: "all", of: [{ kind: "any", of: [{ kind: "not", of: { kind: "dependsOn", phase: "ghost" } }] }] },
        then: "done",
      }],
    })],
  }));
  expect(problems.map((p) => p.code)).toEqual(["unknown-depends-on"]);
});

test("a gate cycle is reported as the path that closes it", () => {
  const problems = validateDescriptor(descriptor({
    phases: [phase("a", { requires: ["c"] }), phase("b", { requires: ["a"] }), phase("c", { requires: ["b"] })],
  }));
  expect(problems.map((p) => p.code)).toEqual(["cycle"]);
  expect(problems[0].message).toMatch(/a -> c -> b -> a|b -> a -> c -> b|c -> b -> a -> c/);
});

test("a cycle through dependsOn, with no gate involved at all", () => {
  // This is the case a gates-only cycle check would pass, and it throws for
  // every unit the moment the workflow is bound.
  const problems = validateDescriptor(descriptor({
    phases: [
      phase("a", { rules: [{ when: { kind: "dependsOn", phase: "b" }, then: "done" }] }),
      phase("b", { rules: [{ when: { kind: "dependsOn", phase: "a" }, then: "done" }] }),
    ],
  }));
  expect(problems.map((p) => p.code)).toEqual(["cycle"]);
});

test("a mixed cycle — one gate edge, one dependsOn edge", () => {
  const problems = validateDescriptor(descriptor({
    phases: [
      phase("a", { requires: ["b"] }),
      phase("b", { rules: [{ when: { kind: "dependsOn", phase: "a" }, then: "done" }] }),
    ],
  }));
  expect(problems.map((p) => p.code)).toEqual(["cycle"]);
});

test("two phases with the same id", () => {
  const problems = validateDescriptor(descriptor({ phases: [phase("a"), phase("a")] }));
  expect(problems.map((p) => p.code)).toEqual(["duplicate-phase"]);
});

test("an artifact generated by a phase that does not exist", () => {
  const problems = validateDescriptor(descriptor({
    phases: [phase("a")],
    artifacts: [{ id: "spec.md", generates: "ghost" }],
  }));
  expect(problems.map((p) => p.code)).toEqual(["unknown-generates"]);
  expect(problems[0].message, "says it fails SILENTLY, which is why it is worth catching here")
    .toContain("Nothing throws");
});

test("an artifact requiring one that is not declared", () => {
  const problems = validateDescriptor(descriptor({
    phases: [phase("a")],
    artifacts: [{ id: "plan.md", generates: "a", requires: ["ghost.md"] }],
  }));
  expect(problems.map((p) => p.code)).toEqual(["unknown-artifact"]);
});

test("no phases at all — refused here rather than on the next load", () => {
  const problems = validateDescriptor(descriptor({ phases: [] }));
  expect(problems.map((p) => p.code)).toEqual(["no-phases"]);
  expect(problems[0].message).toContain("cannot be loaded again");
});

test("problems accumulate — one edit can break several things", () => {
  const problems = validateDescriptor(descriptor({
    phases: [phase("a", { requires: ["ghost"] }), phase("a")],
    artifacts: [{ id: "x.md", generates: "nope" }],
  }));
  expect(problems.map((p) => p.code).sort()).toEqual(["duplicate-phase", "unknown-generates", "unknown-phase"]);
});
