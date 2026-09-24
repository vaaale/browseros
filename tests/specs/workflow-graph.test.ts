// 051 T001/T002/T003 — a workflow's pipeline as a graph, pinned against the
// packs BOS actually ships.
//
// This file exists because the feature's first design was WRONG, and wrong in a
// way only measurement catches. It asserted that `phases[].requires` is the edge
// set. Two of the three installed packs — including the default — declare zero
// such edges, because an unsatisfied one makes a phase `blocked` and that would
// flip 120 live features. The structure is declared in three places instead.
//
// So these tests measure the real descriptors rather than a fixture that agrees
// with whatever the implementation happens to do.
//   npm run test:unit -- tests/specs/workflow-graph.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { workflowGraph } from "../../src/lib/specs/method/graph";
import { loadBuiltinDescriptor } from "../../src/lib/specs/method/builtin-pack";
import type { MethodDescriptor } from "../../src/lib/specs/method/types";

const SPEC_KIT = loadBuiltinDescriptor() as MethodDescriptor;

/** BMAD and OpenSpec ship in the marketplace repo, not this one. Absent is a
 *  real state on a fresh checkout — but it must SKIP LOUDLY, never pass
 *  vacuously. A green tick over an unread file is worse than a red one. */
function marketplacePack(id: string): MethodDescriptor | null {
  for (const base of [
    join(process.cwd(), "data", "user-apps", "items", id, "method", "method.json"),
    join(process.cwd(), "..", "bos-marketplace", "items", id, "method", "method.json"),
  ]) {
    if (existsSync(base)) return JSON.parse(readFileSync(base, "utf8")) as MethodDescriptor;
  }
  return null;
}

test("spec-kit: the DEFAULT method declares no gates at all", () => {
  const g = workflowGraph(SPEC_KIT);
  expect(SPEC_KIT.phases, "12 phases since 051 added ui-design, design and review").toHaveLength(12);
  expect(g.edges.filter((e) => e.kind === "gate"), "and ZERO gates — the fact the first design missed").toEqual([]);

  // 8 edge records over 6 distinct pairs: `specify->plan` and `plan->tasks` are
  // each declared twice, once as an artifact dependency and once as data flow.
  // Both are kept — collapsing them would hide an enforced edge behind a derived
  // one, which matters for OpenSpec.
  expect(g.edges).toHaveLength(8);
  expect(new Set(g.edges.map((e) => `${e.from}->${e.to}`)).size, "6 links, which is what the UI counts").toBe(6);
  expect(g.edges.map((e) => `${e.from}->${e.to}:${e.kind}`).sort()).toEqual([
    "plan->tasks:artifact",
    "plan->tasks:flow",
    "specify->clarify:flow",
    "specify->design:flow",
    "specify->plan:artifact",
    "specify->plan:flow",
    "specify->review:flow",
    "tasks->implement:flow",
  ]);
  expect(g.unreadable, "every file reference in spec-kit is understood").toEqual([]);
});

test("spec-kit: 5 of 12 phases are isolated, each with a reason", () => {
  // Reporting this honestly is the point. It answers a question nothing else in
  // BOS does: which steps can BOS actually observe?
  const g = workflowGraph(SPEC_KIT);
  const byId = Object.fromEntries(g.isolated.map((i) => [i.id, i.reason]));
  expect(Object.keys(byId).sort()).toEqual(["analyze", "constitution", "converge", "test", "ui-design"]);

  expect(byId.analyze, "declares rules: [] — it never reports automatically").toBe("no-rules");
  expect(byId.constitution, "reads a store-scoped file no phase here produces").toBe("reads-outside");
  expect(byId.converge, "writes discrepancies.md; nothing consumes it").toBe("output-unused");
  expect(byId.test, "writes test-results.md; nothing consumes it").toBe("output-unused");
  // ui-design writes a mockup nothing reads, and — being optional — has no
  // `pending` clause tying it to spec.md. So it is genuinely unlinked: the
  // pipeline's ORDER puts it third, but no DEPENDENCY connects it. That gap
  // between declared sequence and declared dependency is real and visible here.
  expect(byId["ui-design"], "writes mockup.html; nothing consumes it").toBe("output-unused");
});

test("a store-scoped read never matches a unit-scoped write of the same name", () => {
  // R6. spec-kit reads a store-scoped constitution and writes a store-scoped
  // discrepancies.md. Matching on filename alone would draw a plausible-looking
  // arrow that is simply false.
  const descriptor: MethodDescriptor = {
    ...SPEC_KIT,
    artifacts: [{ id: "notes.md", generates: "writer" }], // unit-scoped
    phases: [
      { id: "writer", label: "Writer", requires: [], rules: [] },
      // reads the STORE-scoped file of the same name — a different file
      { id: "reader", label: "Reader", requires: [], rules: [{ when: { kind: "exists", file: { rel: "notes.md", scope: "store" } }, then: "done" }] },
    ],
  };
  const g = workflowGraph(descriptor);
  expect(g.edges, "same name, different scope — not the same file").toEqual([]);

  // The control: same name AND same scope does connect.
  const same = workflowGraph({
    ...descriptor,
    phases: [
      descriptor.phases[0],
      { id: "reader", label: "Reader", requires: [], rules: [{ when: { kind: "exists", file: { rel: "notes.md" } }, then: "done" }] },
    ],
  });
  expect(same.edges.map((e) => `${e.from}->${e.to}`)).toEqual(["writer->reader"]);
});

test("an artifact with no producer is normal, not malformed", () => {
  // spec-kit ships three: research.md, data-model.md, quickstart.md. An earlier
  // design listed "an artifact no phase generates" as a structural error, which
  // would have flagged the default method as broken.
  const orphans = SPEC_KIT.artifacts.filter((a) => !a.generates).map((a) => a.id);
  expect(orphans).toEqual(["research.md", "data-model.md", "quickstart.md"]);
  expect(() => workflowGraph(SPEC_KIT)).not.toThrow();
});

test("BMAD: no gates either, and MOST of it is optional", () => {
  const bmad = marketplacePack("bmad");
  test.skip(!bmad, "BMAD is not installed — install the pack to cover it");
  const g = workflowGraph(bmad!);

  // 10 since 048 T024 added `spec` and `retrospective`. `bmad-spec` is the
  // centre of v6's epic path and the pack had no phase for it at all.
  expect(bmad!.phases).toHaveLength(10);

  // The correction that matters. Upstream: "These are independent tools, not
  // stages. Pick the ones the gap calls for, in any order" and "Size Follows the
  // Intent". The pack used to present 8 unconditional steps; 9 of 10 are now
  // declared skippable, which is what the method actually says.
  expect(bmad!.phases.filter((p) => p.optional).map((p) => p.id).sort()).toEqual([
    "architecture", "brief", "epics", "prd", "principles", "retrospective", "review", "spec", "ux",
  ]);
  expect(bmad!.phases.filter((p) => !p.optional).map((p) => p.id), "only the work itself is not").toEqual(["stories"]);

  expect(g.edges.filter((e) => e.kind === "gate")).toEqual([]);
  expect(g.edges).toHaveLength(6);
  expect(new Set(g.edges.map((e) => `${e.from}->${e.to}`)).size, "4 links").toBe(4);
  expect(g.isolated.map((i) => i.id).sort()).toEqual([
    "principles", "retrospective", "review", "spec", "stories", "ux",
  ]);
});

test("OpenSpec: the one pack that uses enforced gates", () => {
  const os = marketplacePack("openspec");
  test.skip(!os, "OpenSpec is not installed — install the pack to cover it");
  const g = workflowGraph(os!);
  expect(os!.phases).toHaveLength(7);
  expect(g.edges.filter((e) => e.kind === "gate"), "6 gates — the only pack that declares any").toHaveLength(6);
  expect(new Set(g.edges.map((e) => `${e.from}->${e.to}`)).size, "6 links").toBe(6);
  expect(g.isolated.map((i) => i.id)).toEqual(["context"]);

  // 12 RECORDS, not 6. Pinned because the distinct-pair count above is blind to
  // the thing that was wrong here: this pack's `artifacts[].requires` named PHASE
  // ids where the schema says artifact ids (`"proposal"` for `"proposal.md"`), so
  // `graph.ts` looked each one up in a map keyed by artifact id, found nothing,
  // and dropped it. Four of its five artifact dependencies were silently missing
  // and every assertion in this test still passed, because each dropped edge
  // duplicated a gate pair that was already counted.
  //
  // 051 T023's validator caught it. The record count is what would have.
  expect(g.edges).toHaveLength(12);
  expect(g.edges.filter((e) => e.kind === "artifact").map((e) => `${e.from}->${e.to}`).sort()).toEqual([
    "design->tasks",
    "proposal->design",
    "proposal->specs",
    "proposal->ui",
    "specs->tasks",
  ]);
});

test("the same pair can be BOTH a gate and a data flow, and both survive", () => {
  // OpenSpec declares tasks->apply as a gate AND apply reads tasks.md. Collapsing
  // them would hide the ENFORCED edge behind the derived one.
  const os = marketplacePack("openspec");
  test.skip(!os, "OpenSpec is not installed");
  const g = workflowGraph(os!);
  const kinds = g.edges.filter((e) => e.from === "tasks" && e.to === "apply").map((e) => e.kind).sort();
  expect(kinds).toEqual(["flow", "gate"]);
});
