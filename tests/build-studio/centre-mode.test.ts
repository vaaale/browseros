// 051 T026 — Build Studio's centre column shows exactly one thing.
//
// It used to arbitrate with a nested ternary over ad-hoc booleans, and
// `showConflictPane` carried `&& !showSelfHeal` to break the tie BY HAND. Two
// modes need one hand-written exclusion; four would need six, and the one that
// goes wrong is silent — two panes claiming the column, or a canvas quietly
// winning over a live conflict session.
//   npm run test:unit -- tests/build-studio/centre-mode.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { resolveCentreMode, type CentreInputs } from "../../src/apps/build-studio/centre-mode";

const none: CentreInputs = {
  selfHeal: { active: false },
  conflict: { sessionId: "", dismissed: false },
  workflowId: "",
};

test("nothing active is the artifact viewer", () => {
  expect(resolveCentreMode(none).kind).toBe("artifact");
});

test("precedence: interruption beats intent, and self-heal beats conflict", () => {
  // A self-heal case and a conflict session HAPPENED and need an answer; a
  // workflow is something the user opened. Between the two interruptions,
  // self-heal wins because it can be the reason the conflict exists.
  expect(resolveCentreMode({ ...none, selfHeal: { active: true } }).kind).toBe("self-heal");
  expect(resolveCentreMode({ ...none, conflict: { sessionId: "s1", dismissed: false } }).kind).toBe("conflict");
  expect(resolveCentreMode({ ...none, workflowId: "spec-kit" }).kind).toBe("workflow");

  // The tie the old chain broke by hand.
  expect(
    resolveCentreMode({ selfHeal: { active: true }, conflict: { sessionId: "s1", dismissed: false }, workflowId: "spec-kit" }).kind,
    "self-heal outranks both",
  ).toBe("self-heal");
  expect(
    resolveCentreMode({ ...none, conflict: { sessionId: "s1", dismissed: false }, workflowId: "spec-kit" }).kind,
    "a live conflict outranks a canvas the user opened",
  ).toBe("conflict");
});

test("a dismissed conflict stops claiming the column", () => {
  expect(resolveCentreMode({ ...none, conflict: { sessionId: "s1", dismissed: true } }).kind).toBe("artifact");
  // …and lets what is underneath through, rather than blocking it.
  expect(
    resolveCentreMode({ ...none, conflict: { sessionId: "s1", dismissed: true }, workflowId: "spec-kit" }).kind,
  ).toBe("workflow");
});

test("EVERY combination yields exactly one mode", () => {
  // The property that makes the nested-ternary class of bug unreachable: the
  // function is total, so there is no arrangement where two panes both believe
  // they own the column, and none where nobody does.
  const seen = new Set<string>();
  for (const active of [false, true]) {
    for (const sessionId of ["", "s1"]) {
      for (const dismissed of [false, true]) {
        for (const workflowId of ["", "spec-kit"]) {
          const mode = resolveCentreMode({ selfHeal: { active }, conflict: { sessionId, dismissed }, workflowId });
          expect(["self-heal", "conflict", "workflow", "artifact"]).toContain(mode.kind);
          seen.add(mode.kind);
        }
      }
    }
  }
  expect([...seen].sort(), "all four are reachable — a mode nothing reaches is dead code").toEqual(
    ["artifact", "conflict", "self-heal", "workflow"],
  );
});

test("the resolved mode carries what its pane needs, so the pane reads no globals", () => {
  const m = resolveCentreMode({ ...none, conflict: { sessionId: "abc", dismissed: false } });
  expect(m).toEqual({ kind: "conflict", sessionId: "abc" });
  const w = resolveCentreMode({ ...none, workflowId: "openspec" });
  expect(w).toEqual({ kind: "workflow", workflowId: "openspec" });
  const s = resolveCentreMode({ ...none, selfHeal: { active: true, caseId: "c9" } });
  expect(s).toEqual({ kind: "self-heal", caseId: "c9" });
});

// ---------------------------------------------------------------------------
// The resolver was right and the INPUTS drifted
// ---------------------------------------------------------------------------

test("a workflow hides the artifact view — which is why leaving one must clear it", () => {
  // The reported bug: open a workflow, then click a spec, and the spec does not
  // appear. Nothing errors; the click just seems to do nothing.
  //
  // This resolver was not wrong. `workflow` outranks `artifact` by design, so
  // that selecting a spec in the tree while the canvas is open does not yank the
  // column out from under it mid-interaction. The defect was one state never
  // being cleared: `openPath` set `activePath` and left `workflowId` standing,
  // so the canvas kept winning forever.
  //
  // Precedence is declared here; the INVARIANT that only one side is selected at
  // a time lives at the call sites, and one of the two never held up its end.
  const both = resolveCentreMode({
    selfHeal: { active: false },
    conflict: { sessionId: "", dismissed: false },
    workflowId: "spec-kit",
  });
  expect(both.kind, "with a workflow set, the artifact view is unreachable").toBe("workflow");

  // …and the fix is expressible as: clearing it returns the column.
  const cleared = resolveCentreMode({
    selfHeal: { active: false },
    conflict: { sessionId: "", dismissed: false },
    workflowId: "",
  });
  expect(cleared.kind).toBe("artifact");
});

test("an INTERRUPTION still outranks a workflow — leaving one must not clear those", () => {
  // The guard on the fix. `openPath` clears `workflowId` and must never be
  // tempted to clear the other two: a self-heal case and a conflict session are
  // things that HAPPENED and need an answer, and browsing a spec is not an
  // answer to either.
  for (const input of [
    { selfHeal: { active: true, caseId: "c1" }, conflict: { sessionId: "", dismissed: false }, workflowId: "spec-kit" },
    { selfHeal: { active: false }, conflict: { sessionId: "s1", dismissed: false }, workflowId: "spec-kit" },
  ]) {
    expect(resolveCentreMode(input).kind, "an interruption beats a workflow").not.toBe("workflow");
  }
});
