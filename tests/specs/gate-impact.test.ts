// 051 T025 — what a new gate would BLOCK, measured against real units.
//
// The hazard this guards is recorded in `PhaseSpec.requires`: one plausible edge
// (`converge requires implement`) flips 120 of 132 live features from `na` to
// `blocked`, because `implement` is `done` on only 12. A gate edit is allowed —
// it is the user's workflow — but not silently.
//
// The discriminating test is the second one. A count that is right when
// everything flips and right when nothing does can still be a constant; this
// suite pins a case where SOME units flip and others do not, for the stated
// reason.
//
//   npm run test:unit -- tests/specs/gate-impact.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync, readFileSync } from "fs";
import { execFileSync } from "child_process";
import { useTestDataDir } from "../services/_test-env";
import { specsRoot } from "../../src/os/specs-dir";
import { ensureStores } from "../../src/lib/specs/seed";
import { ensureBuiltinMethod } from "../../src/lib/specs/method/resolve";
import { __resetMethodsForTest } from "../../src/lib/specs/method/registry";
import { forkWorkflow, registerUserWorkflows, readUserWorkflow } from "../../src/lib/specs/method/user-workflows";
import { applyWorkflowEdit } from "../../src/lib/specs/method/authoring";
import { describeGateImpact, addedGatesBetween } from "../../src/lib/specs/method/gate-impact";
import { loadBuiltinDescriptor } from "../../src/lib/specs/method/builtin-pack";
import type { MethodDescriptor } from "../../src/lib/specs/method/types";

function write(root: string, rel: string, body: string): void {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
}

/**
 * A store with two features that differ in exactly one way: whether `implement`
 * is done.
 *
 *   done-one — tasks.md with every item ticked  => implement resolves `done`
 *   open-one — spec.md only                     => implement resolves `na`
 *
 * `analyze` is the phase under test because it declares NO RULES, so it always
 * falls through to its edges — and gates are consulted ONLY when no clause
 * matched (evaluate.ts). A phase whose rules already answer would be unaffected
 * by a gate, which is exactly the subtlety that makes deriving this count from
 * current states alone wrong.
 */
async function corpus(boundTo: string): Promise<void> {
  await ensureStores();
  const userSpecs = join(specsRoot(), "user-specs");

  const manifest = JSON.parse(readFileSync(join(userSpecs, "spec-store.json"), "utf8")) as Record<string, unknown>;
  write(userSpecs, "spec-store.json", JSON.stringify({ ...manifest, workflow: boundTo }, null, 2));

  write(userSpecs, "alpha/project.json", JSON.stringify({ label: "Alpha" }));
  write(userSpecs, "alpha/001-done-one/spec.md", "# Done\n");
  write(userSpecs, "alpha/001-done-one/plan.md", "# Plan\n");
  write(userSpecs, "alpha/001-done-one/tasks.md", "- [x] T001 one\n- [x] T002 two\n");
  write(userSpecs, "alpha/002-open-one/spec.md", "# Open\n");

  execFileSync("git", ["add", "-A"], { cwd: userSpecs });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "corpus"], { cwd: userSpecs });
}

async function setup(name: string, body: (rev: number) => Promise<void>): Promise<void> {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- a test fixture, not a React hook
  const { cleanup } = useTestDataDir(name);
  try {
    ensureBuiltinMethod();
    const wf = await forkWorkflow("spec-kit", "lean", "Lean");
    await registerUserWorkflows();
    await corpus("lean");
    await body(wf.rev);
  } finally {
    __resetMethodsForTest();
    cleanup();
  }
}

test("a gate that blocks SOME units reports which, and out of how many", async () => {
  await setup("gi-partial", async (rev) => {
    const r = await applyWorkflowEdit("lean", { op: "setRequires", id: "analyze", requires: ["implement"] }, rev, { dryRun: true });

    expect(r.addedGates).toEqual([{ from: "implement", to: "analyze" }]);
    const impact = r.gateImpact;
    expect(impact, "computed for a gate op, not left to the caller").toBeTruthy();
    expect(impact!.examined, "both features were evaluated").toBe(2);
    expect(impact!.stores).toEqual(["user-specs"]);
    expect(impact!.blocked.map((b) => b.unit)).toEqual(["user-specs/alpha/002-open-one"]);
    expect(impact!.blocked[0].phases).toEqual(["analyze"]);

    const text = describeGateImpact(impact!);
    expect(text, "the denominator matters as much as the count").toContain("1 of 2 unit(s)");
    expect(text).toContain("user-specs/alpha/002-open-one");
    expect(text, "says the content is not changed").toMatch(/not changed/i);
  });
});

test("a gate that blocks nothing says so, with the number it checked", async () => {
  await setup("gi-none", async (rev) => {
    // `specify` is `done` on both features (spec.md exists), so gating on it
    // changes nothing — and the report must distinguish that from "nothing was
    // looked at".
    const r = await applyWorkflowEdit("lean", { op: "setRequires", id: "analyze", requires: ["specify"] }, rev, { dryRun: true });
    const impact = r.gateImpact!;
    expect(impact.blocked).toEqual([]);
    expect(impact.examined).toBe(2);
    expect(describeGateImpact(impact)).toContain("all 2 unit(s)");
  });
});

test("nothing bound is reported as UNCHECKED, not as a clean bill of health", async () => {
  // The distinction the whole `examined` field exists for: a fork nobody has
  // bound yet legitimately blocks nothing, and saying "blocks nothing" would be
  // read as "this edge is safe".
  // eslint-disable-next-line react-hooks/rules-of-hooks -- a test fixture, not a React hook
  const { cleanup } = useTestDataDir("gi-unbound");
  try {
    ensureBuiltinMethod();
    const wf = await forkWorkflow("spec-kit", "lean", "Lean");
    await registerUserWorkflows();
    await corpus("spec-kit"); // the store stays on the PACK's workflow

    const r = await applyWorkflowEdit("lean", { op: "setRequires", id: "analyze", requires: ["implement"] }, wf.rev, { dryRun: true });
    const impact = r.gateImpact!;
    expect(impact.examined).toBe(0);
    expect(impact.stores).toEqual([]);
    expect(impact.blocked).toEqual([]);

    const text = describeGateImpact(impact);
    expect(text).toContain("no store or project is bound");
    expect(text, "must not claim safety").not.toMatch(/blocks nothing/);
  } finally {
    __resetMethodsForTest();
    cleanup();
  }
});

test("an op that adds no gate does no walk at all", async () => {
  await setup("gi-nogate", async (rev) => {
    const r = await applyWorkflowEdit("lean", { op: "setOptional", id: "clarify", optional: false }, rev, { dryRun: true });
    expect(r.addedGates).toEqual([]);
    expect(r.gateImpact, "absent, not an empty report — the walk is not free").toBeUndefined();
  });
});

test("REMOVING a gate is not warned about — it can only unblock", async () => {
  await setup("gi-remove", async (rev) => {
    const withGate = await applyWorkflowEdit("lean", { op: "setRequires", id: "analyze", requires: ["implement"] }, rev);
    const removed = await applyWorkflowEdit("lean", { op: "setRequires", id: "analyze", requires: [] }, withGate.workflow.rev, { dryRun: true });
    expect(removed.addedGates).toEqual([]);
    expect(removed.gateImpact).toBeUndefined();
  });
});

test("the real apply reports the same impact the dry run did", async () => {
  // The dry run's whole job is to be what happens. Two code paths producing two
  // answers is the failure this feature's design is organised against.
  await setup("gi-same", async (rev) => {
    const preview = await applyWorkflowEdit("lean", { op: "setRequires", id: "analyze", requires: ["implement"] }, rev, { dryRun: true });
    const applied = await applyWorkflowEdit("lean", { op: "setRequires", id: "analyze", requires: ["implement"] }, rev);
    expect(applied.gateImpact?.blocked).toEqual(preview.gateImpact?.blocked);
    expect(applied.gateImpact?.examined).toEqual(preview.gateImpact?.examined);
    expect(preview.preview).toBe(true);
    expect(applied.preview).toBe(false);
    expect((await readUserWorkflow("lean"))!.rev, "only the real one wrote").toBe(rev + 1);
  });
});

test("addedGatesBetween finds what two descriptors differ by", () => {
  const base = loadBuiltinDescriptor() as MethodDescriptor;
  const next: MethodDescriptor = {
    ...base,
    phases: base.phases.map((p) => (p.id === "analyze" ? { ...p, requires: ["implement"] } : p)),
  };
  expect(addedGatesBetween(base, next)).toEqual([{ from: "implement", to: "analyze" }]);
  expect(addedGatesBetween(next, base), "removal is not an addition").toEqual([]);
});
