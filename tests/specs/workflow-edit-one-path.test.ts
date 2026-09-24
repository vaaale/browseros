// 051 T024 — SC-011: the canvas and the agent are ONE implementation.
//
// The acceptance the task asks for is literally "drive both paths at one
// validator in one test", so that is what this file does: every case runs the
// HTTP route and the `methods_edit` tool against the same fork and asserts they
// agree. Testing them separately is what allows a drift to pass twice.
//
// This matters here more than usual. 049's `lifecycle.ts` exists because the
// agent tools and the Build Studio context menus HAD drifted into two
// implementations of one operation; the whole shape of `authoring.ts` is a
// response to that, and an assertion is the only thing that keeps it true.
//
//   npm run test:unit -- tests/specs/workflow-edit-one-path.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { useTestDataDir } from "../services/_test-env";
import { PATCH } from "../../src/app/api/workflows/route";
import { ensureBuiltinMethod } from "../../src/lib/specs/method/resolve";
import { __resetMethodsForTest } from "../../src/lib/specs/method/registry";
import { forkWorkflow, registerUserWorkflows, readUserWorkflow } from "../../src/lib/specs/method/user-workflows";
import { projectLifecycleTools } from "../../src/lib/assistant/tools/server/specs";
import type { WorkflowOp } from "../../src/lib/specs/method/authoring";

interface RouteResult { status: number; body: Record<string, unknown> }

async function viaRoute(id: string, op: WorkflowOp, rev: number, preview = false): Promise<RouteResult> {
  const req = new Request("http://t/api/workflows", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, op, rev, preview }),
  }) as unknown as Parameters<typeof PATCH>[0];
  const res = await PATCH(req);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** The agent's path. Same op, expressed the way a tool call expresses it. */
async function viaTool(args: Record<string, unknown>): Promise<string> {
  const tool = projectLifecycleTools().methods_edit;
  const out = await tool.execute!(args, {} as never);
  return typeof out === "string" ? out : JSON.stringify(out);
}

async function withFork(name: string, body: (rev: number) => Promise<void>): Promise<void> {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- a test fixture, not a React hook
  const { cleanup } = useTestDataDir(name);
  try {
    ensureBuiltinMethod();
    const wf = await forkWorkflow("spec-kit", "lean", "Lean");
    await registerUserWorkflows();
    await body(wf.rev);
  } finally {
    __resetMethodsForTest();
    cleanup();
  }
}

test("both paths REFUSE a pack's workflow, with the same reason", async () => {
  await withFork("wep-pack", async () => {
    const route = await viaRoute("spec-kit", { op: "setOptional", id: "clarify", optional: false }, 1);
    expect(route.status, "a refusal is a conflict, not a server fault").toBe(409);
    expect(route.body.code).toBe("not-yours");
    expect(String(route.body.error)).toContain("Fork it");

    const tool = await viaTool({ workflow: "spec-kit", rev: 1, op: "setOptional", phase: "clarify", optional: false });
    expect(tool).toContain("not-yours");
    expect(tool, "the same sentence, because it is the same throw").toContain("Fork it");
  });
});

test("both paths REFUSE a stale rev, naming the same revisions", async () => {
  await withFork("wep-stale", async (rev) => {
    await viaRoute("lean", { op: "setOptional", id: "clarify", optional: false }, rev);

    const route = await viaRoute("lean", { op: "setOptional", id: "analyze", optional: true }, rev);
    expect(route.body.code).toBe("stale");
    const tool = await viaTool({ workflow: "lean", rev, op: "setOptional", phase: "analyze", optional: true });
    expect(tool).toContain("stale");
    expect(tool).toContain(`now at ${rev + 1}`);
    expect(String(route.body.error)).toContain(`now at ${rev + 1}`);
  });
});

test("both paths REFUSE the same invalid structure, from the same validator", async () => {
  await withFork("wep-invalid", async (rev) => {
    const route = await viaRoute("lean", { op: "setRequires", id: "tasks", requires: ["ghost"] }, rev);
    expect(route.body.code).toBe("no-such-phase");

    const tool = await viaTool({ workflow: "lean", rev, op: "setRequires", phase: "tasks", requires: ["ghost"] });
    expect(tool).toContain("no-such-phase");
    expect(tool).toContain("ghost");
  });
});

test("a cycle is caught identically, and neither path writes", async () => {
  await withFork("wep-cycle", async (rev) => {
    const setup = await viaRoute("lean", { op: "setRequires", id: "plan", requires: ["tasks"] }, rev);
    const rev2 = setup.body.rev as number;

    const route = await viaRoute("lean", { op: "setRequires", id: "tasks", requires: ["plan"] }, rev2);
    expect(route.body.code).toBe("invalid");
    expect((route.body.problems as Array<{ code: string }>).map((p) => p.code)).toEqual(["cycle"]);

    const tool = await viaTool({ workflow: "lean", rev: rev2, op: "setRequires", phase: "tasks", requires: ["plan"] });
    expect(tool).toContain("invalid");
    expect((await readUserWorkflow("lean"))!.rev, "two refusals, no writes").toBe(rev2);
  });
});

test("an APPLIED edit from either path is visible to the other", async () => {
  // The property that makes "one implementation" observable rather than merely
  // asserted about the source: the agent edits, the canvas's own endpoint sees
  // it, and vice versa — including the rev each must then use.
  await withFork("wep-interop", async (rev) => {
    const tool = await viaTool({ workflow: "lean", rev, op: "addPhase", phase: "handover", label: "Handover", after: "specify" });
    expect(tool).toContain("revision 2");

    const route = await viaRoute("lean", { op: "renamePhase", id: "handover", label: "Hand-over" }, 2);
    expect(route.status).toBe(200);
    expect(route.body.rev).toBe(3);

    const d = (await readUserWorkflow("lean"))!.descriptor;
    const ids = d.phases.map((p) => p.id);
    expect(ids[ids.indexOf("specify") + 1]).toBe("handover");
    expect(d.phases.find((p) => p.id === "handover")?.label).toBe("Hand-over");
  });
});

test("both paths report the SAME gate warning — the agent cannot skip it", async () => {
  // The design put this in front of the canvas's Apply button. Computing it
  // there would mean `methods_edit` never saw it, so it is computed in
  // applyWorkflowEdit and both transports render the same field.
  await withFork("wep-gate", async (rev) => {
    const route = await viaRoute("lean", { op: "setRequires", id: "analyze", requires: ["implement"] }, rev, true);
    expect(route.body.gateImpact, "the canvas gets a structured report").toBeTruthy();
    expect(String(route.body.gateImpactText)).toContain("implement -> analyze");

    const tool = await viaTool({ workflow: "lean", rev, op: "setRequires", phase: "analyze", requires: ["implement"], preview: true });
    expect(tool, "and the agent gets the same sentence").toContain("implement -> analyze");
    expect(tool).toContain("PREVIEW");
  });
});

test("preview writes nothing, and hands back the rev the caller still holds", async () => {
  await withFork("wep-preview", async (rev) => {
    const route = await viaRoute("lean", { op: "addPhase", id: "handover" }, rev, true);
    expect(route.body.preview).toBe(true);
    expect(route.body.rev, "NOT the would-be rev — adopting that would make the next real edit stale").toBe(rev);
    expect((await readUserWorkflow("lean"))!.rev).toBe(rev);
    expect((await readUserWorkflow("lean"))!.descriptor.phases.map((p) => p.id)).not.toContain("handover");
  });
});

test("a missing rev is refused rather than defaulted", async () => {
  await withFork("wep-norev", async () => {
    const req = new Request("http://t/api/workflows", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "lean", op: { op: "setOptional", id: "clarify", optional: false } }),
    }) as unknown as Parameters<typeof PATCH>[0];
    const res = await PATCH(req);
    expect(res.status).toBe(400);
    expect(String(((await res.json()) as { error: string }).error)).toContain("rev is required");
  });
});

test("the tool names the operations it accepts when given one it does not", async () => {
  await withFork("wep-badop", async (rev) => {
    const tool = await viaTool({ workflow: "lean", rev, op: "deletePhase", phase: "plan" });
    expect(tool).toContain("is not an operation");
    expect(tool, "an agent needs the list, not a rejection").toContain("removePhase");
  });
});

test("movePhase to FIRST works through the tool — `after: ''` is a position, not an omission", async () => {
  await withFork("wep-move-first", async (rev) => {
    await viaTool({ workflow: "lean", rev, op: "movePhase", phase: "implement", after: "" });
    expect((await readUserWorkflow("lean"))!.descriptor.phases[0].id).toBe("implement");
  });
});
