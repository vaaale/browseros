// 049 — workflow resolution (FR-002 … FR-005).
//   npm run test:unit -- tests/specs/workflows.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { registerMethod, __resetMethodsForTest } from "../../src/lib/specs/method/registry";
import { loadBuiltinDescriptor } from "../../src/lib/specs/method/builtin-pack";
import {
  listWorkflows, resolveWorkflow, workflowsOf, defaultWorkflowOf,
  WorkflowNotFoundError, WorkflowAmbiguousError,
} from "../../src/lib/specs/method/workflows";
import type { MethodDescriptor } from "../../src/lib/specs/method/types";

const SPEC_KIT = loadBuiltinDescriptor();
const mk = (id: string, workflows?: MethodDescriptor["workflows"]): MethodDescriptor =>
  ({ ...SPEC_KIT, id, label: id.toUpperCase(), ...(workflows ? { workflows } : {}) });

test("a method declaring NO workflows has exactly one, named for itself", () => {
  // This is what keeps every pre-049 `method: "bmad"` binding working. If a
  // bare method id stopped resolving, every existing store would need migrating
  // — so the compatible case is the DEFAULT, not a special case bolted on.
  __resetMethodsForTest();
  registerMethod(SPEC_KIT);
  const wfs = workflowsOf(SPEC_KIT);
  expect(wfs).toHaveLength(1);
  expect(wfs[0].id).toBe("spec-kit");
  expect(wfs[0].isDefault, "and it is the default, or a bare method id is unresolvable").toBe(true);
  expect(resolveWorkflow("spec-kit").qualified).toBe("spec-kit:spec-kit");
});

test("a bare METHOD id resolves to that method's default workflow", () => {
  __resetMethodsForTest();
  registerMethod(SPEC_KIT);
  registerMethod(mk("bmad", [
    { id: "simple" },
    { id: "enterprise", default: true },
  ]));
  expect(resolveWorkflow("bmad").id, "the marked default, not the first declared").toBe("enterprise");
  expect(resolveWorkflow("bmad:simple").id).toBe("simple");
});

test("a pack marking no default gets its FIRST declared one", () => {
  // Having no default at all would make a bare method id unresolvable, which is
  // the one form that must never break.
  __resetMethodsForTest();
  registerMethod(mk("x", [{ id: "a" }, { id: "b" }]));
  expect(defaultWorkflowOf(mk("x", [{ id: "a" }, { id: "b" }])).id).toBe("a");
});

test("FR-004 — a bare name provided by TWO methods is REPORTED, not resolved by order", () => {
  // Same rule as 045 FR-001a for duplicate agent ids: resolving by registration
  // order makes "which one did I get" depend on history nobody can inspect.
  __resetMethodsForTest();
  registerMethod(mk("alpha", [{ id: "standard" }]));
  registerMethod(mk("beta", [{ id: "standard" }]));

  let err: Error | undefined;
  try { resolveWorkflow("standard"); } catch (e) { err = e as Error; }
  expect(err).toBeInstanceOf(WorkflowAmbiguousError);
  expect(err!.message, "names both providers AND the qualified form that works").toMatch(/alpha.*beta|beta.*alpha/);
  expect(err!.message).toContain(':standard"');

  // Qualifying resolves it.
  expect(resolveWorkflow("beta:standard").method.id).toBe("beta");
});

test("FR-005 — an unknown workflow is REFUSED and lists what exists", () => {
  // Never fall back to a default: a project silently created under the wrong
  // framework is discovered much later, by its artifacts having wrong names.
  __resetMethodsForTest();
  registerMethod(SPEC_KIT);

  let err: Error | undefined;
  try { resolveWorkflow("no-such-workflow"); } catch (e) { err = e as Error; }
  expect(err).toBeInstanceOf(WorkflowNotFoundError);
  expect(err!.message).toContain("no-such-workflow");
  expect(err!.message, "lists the available ones so the user can act").toContain("spec-kit:spec-kit");
});

test("a method id beats another method's workflow of the same name", () => {
  // `resolveWorkflow("bmad")` must mean BMAD, even if some other pack happens to
  // call one of its workflows "bmad".
  __resetMethodsForTest();
  registerMethod(mk("bmad", [{ id: "enterprise" }]));
  registerMethod(mk("other", [{ id: "bmad" }]));
  expect(resolveWorkflow("bmad").method.id).toBe("bmad");
  expect(resolveWorkflow("other:bmad").method.id).toBe("other");
});

test("listWorkflows spans every installed method", () => {
  __resetMethodsForTest();
  registerMethod(SPEC_KIT);
  registerMethod(mk("bmad", [{ id: "simple" }, { id: "enterprise", default: true }]));
  expect(listWorkflows().map((w) => w.qualified).sort())
    .toEqual(["bmad:enterprise", "bmad:simple", "spec-kit:spec-kit"]);
});
