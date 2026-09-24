// 051 T004 — the workflow canvas's data.
//
// The canvas is a client component and cannot reach `graph.ts`. Without this
// route Phase 1 has no way to run end to end — the omission that the review's
// F8 caught, after it had been designed and then built by nothing.
//   npm run test:unit -- tests/specs/workflows-api.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { useTestDataDir } from "../services/_test-env";
import { GET, POST, DELETE } from "../../src/app/api/workflows/route";
import type { WorkflowSummary, WorkflowDetail } from "../../src/app/api/workflows/route";

const req = (url: string) => new Request(url) as unknown as Parameters<typeof GET>[0];

async function list(): Promise<WorkflowSummary[]> {
  const res = await GET(req("http://t/api/workflows"));
  return ((await res.json()) as { workflows: WorkflowSummary[] }).workflows;
}
async function detail(id: string) {
  const res = await GET(req(`http://t/api/workflows?id=${id}`));
  return { status: res.status, body: (await res.json()) as { workflow?: WorkflowDetail; error?: string } };
}

test("the list reports LINKS and GATES separately", async () => {
  const { cleanup } = useTestDataDir("wf-api-list");
  try {
    const specKit = (await list()).find((w) => w.id === "spec-kit");
    expect(specKit, "the built-in is always there").toBeTruthy();
    expect(specKit!.phases).toBe(12);
    expect(specKit!.links, "6 distinct pairs").toBe(6);
    expect(specKit!.gates, "and ZERO enforced — the distinction the UI exists to show").toBe(0);
    expect(specKit!.isolated).toBe(5);
    expect(specKit!.customizable, "spec-kit declares no override surface").toBe(false);
  } finally {
    cleanup();
  }
});

test("the detail carries a laid-out graph the client does not have to compute", async () => {
  const { cleanup } = useTestDataDir("wf-api-detail");
  try {
    const { status, body } = await detail("spec-kit");
    expect(status).toBe(200);
    const w = body.workflow!;

    // Position is the pack's DECLARED order, not a dependency depth. Only 2 of
    // spec-kit's 11 consecutive steps are backed by a dependency, so laying out
    // by depth scattered a pipeline whose order is mostly conventional.
    const order = Object.fromEntries(w.nodes.map((n) => [n.id, n.order]));
    expect(order.constitution, "first in phases[]").toBe(0);
    expect(order.specify).toBe(1);
    expect(order["ui-design"], "fourth, because the pack lists it fourth").toBe(3);
    expect(order.design).toBe(4);
    expect(order.review).toBe(5);
    // ...and it keeps that place even though NOTHING depends on it.
    expect(w.isolatedPhases.map((i) => i.id)).toContain("ui-design");
    expect(w.nodes.find((n) => n.id === "ui-design")!.optional, "the [X] in the request").toBe(true);

    // What the pack declared about a phase, not an interpretation (FR-020).
    expect(w.nodes.find((n) => n.id === "specify")!.writes).toEqual(["spec.md"]);
    expect(w.nodes.find((n) => n.id === "implement")!.reads).toEqual(["tasks.md"]);
    expect(w.nodes.find((n) => n.id === "analyze")!.writes, "declares nothing, shows nothing").toEqual([]);
    expect(w.nodes.find((n) => n.id === "ui-design")!.writes, "051's optional phase").toEqual(["mockup.html"]);

    expect(w.isolatedPhases.map((i) => i.id).sort()).toEqual(["analyze", "constitution", "converge", "test", "ui-design"]);
    expect(w.unreadable, "every reference in spec-kit is understood").toEqual([]);
  } finally {
    cleanup();
  }
});

test("an unknown workflow is a 404 that names it, not an empty graph", async () => {
  const { cleanup } = useTestDataDir("wf-api-404");
  try {
    const { status, body } = await detail("no-such-workflow");
    expect(status).toBe(404);
    expect(body.error).toContain("no-such-workflow");
    expect(body.workflow, "an empty graph would render as 'this pipeline has no steps'").toBeUndefined();
  } finally {
    cleanup();
  }
});

test("fork through the route, and it becomes a first-class workflow", async () => {
  const { cleanup } = useTestDataDir("wf-api-fork");
  try {
    const res = await POST(new Request("http://t/api/workflows", {
      method: "POST",
      body: JSON.stringify({ source: "spec-kit", id: "lean", label: "Lean" }),
    }) as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(200);

    const all = await list();
    const lean = all.find((w) => w.id === "lean")!;
    expect(lean, "listed beside the packs, not in a second category").toBeTruthy();
    expect(lean.owned, "and marked as the user's, with what it came from").toEqual({
      from: "spec-kit",
      fromVersion: (all.find((w) => w.id === "spec-kit"))!.version,
      // 051 T021 — `rev` travels with the rest so the canvas can state the
      // revision it edited against. Fetching it at Save time instead would read
      // a NEWER revision than the one on screen, which is the concurrent
      // overwrite the check exists to catch.
      rev: 1,
      // FR-008 — drift, as a NOTICE. A fork freshly taken is level with its
      // source; the canvas only says anything when these disagree.
      currentVersion: (all.find((w) => w.id === "spec-kit"))!.version,
      behind: false,
    });
    expect(all.find((w) => w.id === "spec-kit")!.owned, "a pack's own is not owned").toBeUndefined();
  } finally {
    cleanup();
  }
});

test("the detail says HOW MANY phases BOS can describe, and names the driver skill", async () => {
  // Counts prompts OR skills (048 FR-028). Counting `instructions` alone
  // reported "0 of 10" for BMAD while every phase named a skill carrying one —
  // the pane said "declares no prompts" over eight files of exactly what the
  // user was asking to see.
  const { cleanup } = useTestDataDir("wf-api-prompts");
  try {
    const { status, body } = await detail("spec-kit");
    expect(status).toBe(200);
    const w = body.workflow!;
    expect(w.describedPhases, "8 of spec-kit's 12 declare a prompt; it uses no skills").toBe(8);
    expect(w.phases).toBe(12);
    expect(w.driverSkill).toBe("spec-kit-driver");
    // And per node, so the canvas can mark it without a second request.
    expect(w.nodes.filter((n) => n.hasInstructions)).toHaveLength(8);
    expect(w.nodes.filter((n) => !n.hasInstructions).map((n) => n.id).sort())
      .toEqual(["design", "review", "test", "ui-design"]);
  } finally {
    cleanup();
  }
});

test("a pack that declares NO prompts at all reports zero — the BMAD/OpenSpec state", async () => {
  // Both shipped marketplace packs are in exactly this state, and neither is
  // present in a sandboxed data dir — so the state is reproduced from a
  // descriptor rather than skipped, which keeps the assertion running everywhere.
  const { cleanup } = useTestDataDir("wf-api-no-prompts");
  try {
    const { getMethod, registerMethod, __resetMethodsForTest } = await import("../../src/lib/specs/method/registry");
    const { ensureBuiltinMethod } = await import("../../src/lib/specs/method/resolve");
    ensureBuiltinMethod();
    const base = getMethod("spec-kit")!;
    registerMethod({
      ...base,
      id: "promptless", label: "Promptless", builtin: false,
      driverSkill: "promptless-driver",
      phases: base.phases.map((p) => ({ ...p, instructions: undefined, skills: undefined })),
    });

    const w = (await detail("promptless")).body.workflow!;
    expect(w.describedPhases, "zero, and that is the pack's design").toBe(0);
    expect(w.nodes.some((n) => n.hasInstructions)).toBe(false);
    expect(w.driverSkill, "so the UI can say WHERE the instructions actually are").toBe("promptless-driver");
    __resetMethodsForTest();
  } finally {
    cleanup();
  }
});

test("a fork whose source has moved on reports it — a fork must not be a SILENT freeze", async () => {
  // FR-008. Without this the user believes they are current when the pack is two
  // versions ahead. A notice, never a merge: the upgrade is "re-fork and re-apply
  // with judgement", which is an agent's job.
  const { cleanup } = useTestDataDir("wf-api-drift");
  try {
    await POST(new Request("http://t/api/workflows", {
      method: "POST", body: JSON.stringify({ source: "spec-kit", id: "lean" }),
    }) as unknown as Parameters<typeof POST>[0]);

    const { getMethod, registerMethod } = await import("../../src/lib/specs/method/registry");
    const { __resetMethodsForTest } = await import("../../src/lib/specs/method/registry");
    const moved = { ...getMethod("spec-kit")!, version: "9.9.9" };
    registerMethod(moved);

    const owned = (await list()).find((w) => w.id === "lean")!.owned!;
    expect(owned.fromVersion, "what it was taken at, unchanged").toBe("1.0.0");
    expect(owned.currentVersion, "and what exists now").toBe("9.9.9");
    expect(owned.behind).toBe(true);
    __resetMethodsForTest();
  } finally {
    cleanup();
  }
});

test("a fork whose source pack is UNINSTALLED still works, and says that instead", async () => {
  // Forked from an INSTALLED pack, not from spec-kit: `ensureBuiltinMethod`
  // re-registers the built-in on every GET, so it cannot be made to vanish and
  // could not reach this branch. Uninstalling is a real thing that happens to a
  // marketplace pack, and a fork surviving it is the property that distinguishes
  // a fork from an override (SC-001).
  const { cleanup } = useTestDataDir("wf-api-source-gone");
  try {
    const { getMethod, registerMethod, unregisterMethod, __resetMethodsForTest } =
      await import("../../src/lib/specs/method/registry");
    const { ensureBuiltinMethod } = await import("../../src/lib/specs/method/resolve");
    ensureBuiltinMethod();
    registerMethod({ ...getMethod("spec-kit")!, id: "somepack", label: "Some pack", version: "2.0.0", builtin: false });

    await POST(new Request("http://t/api/workflows", {
      method: "POST", body: JSON.stringify({ source: "somepack", id: "mine" }),
    }) as unknown as Parameters<typeof POST>[0]);

    unregisterMethod("somepack");

    const all = await list();
    expect(all.map((w) => w.id), "the source is gone").not.toContain("somepack");
    const owned = all.find((w) => w.id === "mine")!.owned!;
    expect(owned.currentVersion, "no source to compare against").toBeNull();
    expect(owned.behind, "and therefore NOT behind — there is nothing to be behind").toBe(false);
    __resetMethodsForTest();
  } finally {
    cleanup();
  }
});

test("a pack's workflow cannot be deleted, and says why", async () => {
  // An action that always fails is worse than no action — so the UI needs to know
  // which of the two it is looking at, and the refusal has to name the remedy.
  const { cleanup } = useTestDataDir("wf-api-delete-pack");
  try {
    const res = await DELETE(new Request("http://t/api/workflows?id=spec-kit", { method: "DELETE" }) as unknown as Parameters<typeof DELETE>[0]);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/comes from a pack/);
    expect(body.error, "and points at what WOULD work").toMatch(/Uninstall the pack/);
  } finally {
    cleanup();
  }
});

test("deleting a fork removes it from the list", async () => {
  const { cleanup } = useTestDataDir("wf-api-delete-fork");
  try {
    await POST(new Request("http://t/api/workflows", {
      method: "POST", body: JSON.stringify({ source: "spec-kit", id: "temp" }),
    }) as unknown as Parameters<typeof POST>[0]);
    expect((await list()).some((w) => w.id === "temp")).toBe(true);

    const res = await DELETE(new Request("http://t/api/workflows?id=temp", { method: "DELETE" }) as unknown as Parameters<typeof DELETE>[0]);
    expect(res.status).toBe(200);
    expect((await list()).some((w) => w.id === "temp"), "gone from the registry too, not just from disk").toBe(false);
  } finally {
    cleanup();
  }
});
