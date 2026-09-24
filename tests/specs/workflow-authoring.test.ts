// 051 T021/T022 — the one mutation path.
//
// Two properties dominate this file, and both are about SILENCE:
//   - an op never leaves a workflow structurally broken (the validator runs
//     before the write, not after);
//   - an op never does something the user did not ask for without SAYING so —
//     `removePhase` drops gates and orphans artifacts, and every one comes back
//     as a warning rather than as a diff someone notices later.
//
//   npm run test:unit -- tests/specs/workflow-authoring.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { useTestDataDir } from "../services/_test-env";
import { ensureBuiltinMethod } from "../../src/lib/specs/method/resolve";
import { getMethod, __resetMethodsForTest } from "../../src/lib/specs/method/registry";
import { forkWorkflow, readUserWorkflow, writeUserWorkflow } from "../../src/lib/specs/method/user-workflows";
import { applyWorkflowEdit, WorkflowEditRefused } from "../../src/lib/specs/method/authoring";
import type { UserWorkflow } from "../../src/lib/specs/method/user-workflows";

/** Fork spec-kit into `lean`, and hand back its current rev. */
async function forked(): Promise<{ rev: number }> {
  ensureBuiltinMethod();
  const wf = await forkWorkflow("spec-kit", "lean", "Lean");
  return { rev: wf.rev };
}

/** Rewrite a fork's descriptor wholesale, for tests that need a shape spec-kit
 *  does not ship (a gate, a dependsOn). Goes through the real writer. */
async function reshape(mut: (wf: UserWorkflow) => void): Promise<number> {
  const wf = (await readUserWorkflow("lean"))!;
  mut(wf);
  await writeUserWorkflow("lean", wf);
  return wf.rev;
}

async function withFork(name: string, body: (rev: number) => Promise<void>): Promise<void> {
  // `useTestDataDir` is this repo's test fixture, not a React hook — the name
  // predates this file. `rules-of-hooks` matches on the `use` prefix alone, so
  // it fires for any named helper that calls it; every other test in the suite
  // calls it from an anonymous arrow, which is why this is the first sighting.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { cleanup } = useTestDataDir(name);
  try {
    const { rev } = await forked();
    await body(rev);
  } finally {
    __resetMethodsForTest();
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// Who may edit
// ---------------------------------------------------------------------------

test("a PACK's workflow is refused, and the refusal says to fork", async () => {
  const { cleanup } = useTestDataDir("wa-pack");
  try {
    ensureBuiltinMethod();
    const err = await applyWorkflowEdit("spec-kit", { op: "setOptional", id: "clarify", optional: false }, 1)
      .then(() => null, (e: unknown) => e as WorkflowEditRefused);
    expect(err?.code).toBe("not-yours");
    expect(err?.message, "names the route, because a refusal with no way forward is just a wall").toContain("Fork it");
    expect(getMethod("spec-kit")?.phases.find((p) => p.id === "clarify")?.optional, "untouched").toBe(true);
  } finally {
    __resetMethodsForTest();
    cleanup();
  }
});

test("a workflow that does not exist is refused as such, not as 'not yours'", async () => {
  const { cleanup } = useTestDataDir("wa-missing");
  try {
    ensureBuiltinMethod();
    const err = await applyWorkflowEdit("ghost", { op: "removePhase", id: "x" }, 1)
      .then(() => null, (e: unknown) => e as WorkflowEditRefused);
    expect(err?.code).toBe("not-yours");
    expect(err?.message).toContain('no workflow called "ghost"');
  } finally {
    __resetMethodsForTest();
    cleanup();
  }
});

test("a stale rev is refused, naming both revisions", async () => {
  await withFork("wa-stale", async (rev) => {
    await applyWorkflowEdit("lean", { op: "setOptional", id: "clarify", optional: false }, rev);
    // The caller still holds the rev from before that write.
    const err = await applyWorkflowEdit("lean", { op: "setOptional", id: "analyze", optional: true }, rev)
      .then(() => null, (e: unknown) => e as WorkflowEditRefused);
    expect(err?.code).toBe("stale");
    expect(err?.message).toContain(`revision ${rev}`);
    expect(err?.message).toContain(`now at ${rev + 1}`);
  });
});

test("rev increments on every write, so the next edit must be made against it", async () => {
  await withFork("wa-rev", async (rev) => {
    const a = await applyWorkflowEdit("lean", { op: "setOptional", id: "clarify", optional: false }, rev);
    expect(a.workflow.rev).toBe(rev + 1);
    const b = await applyWorkflowEdit("lean", { op: "setOptional", id: "clarify", optional: true }, a.workflow.rev);
    expect(b.workflow.rev).toBe(rev + 2);
  });
});

// ---------------------------------------------------------------------------
// The ops
// ---------------------------------------------------------------------------

test("addPhase places it by POSITION, because position is the pipeline", async () => {
  await withFork("wa-add", async (rev) => {
    const r = await applyWorkflowEdit("lean", { op: "addPhase", id: "handover", label: "Handover", after: "specify" }, rev);
    const ids = r.workflow.descriptor.phases.map((p) => p.id);
    expect(ids[ids.indexOf("specify") + 1]).toBe("handover");
    expect(r.warnings.join(" "), "a phase with no rules is unobservable, and says so")
      .toContain("cannot observe whether it is done");
  });
});

test("addPhase with no `after` goes last", async () => {
  await withFork("wa-add-last", async (rev) => {
    const r = await applyWorkflowEdit("lean", { op: "addPhase", id: "handover" }, rev);
    expect(r.workflow.descriptor.phases.at(-1)?.id).toBe("handover");
  });
});

test("a duplicate id is refused", async () => {
  await withFork("wa-dupe", async (rev) => {
    const err = await applyWorkflowEdit("lean", { op: "addPhase", id: "specify" }, rev)
      .then(() => null, (e: unknown) => e as WorkflowEditRefused);
    expect(err?.code).toBe("invalid");
  });
});

test("movePhase reorders, and nothing else changes", async () => {
  await withFork("wa-move", async (rev) => {
    const before = (await readUserWorkflow("lean"))!.descriptor.phases.map((p) => p.id);
    const r = await applyWorkflowEdit("lean", { op: "movePhase", id: "implement", after: null }, rev);
    const after = r.workflow.descriptor.phases.map((p) => p.id);
    expect(after[0]).toBe("implement");
    expect([...after].sort(), "same phases, different order").toEqual([...before].sort());
  });
});

test("removePhase drops the gates that pointed at it, and SAYS so", async () => {
  await withFork("wa-remove-gate", async () => {
    // spec-kit declares no gates at all, so one has to be introduced to test this.
    const rev = await reshape((wf) => {
      const tasks = wf.descriptor.phases.find((p) => p.id === "tasks")!;
      tasks.requires = ["plan"];
    });
    const r = await applyWorkflowEdit("lean", { op: "removePhase", id: "plan" }, rev);
    expect(r.workflow.descriptor.phases.find((p) => p.id === "tasks")?.requires).toEqual([]);
    expect(r.warnings.join(" ")).toContain('no longer waits for "plan"');
  });
});

test("removePhase orphans the artifacts it produced, and SAYS so", async () => {
  await withFork("wa-remove-artifact", async (rev) => {
    const r = await applyWorkflowEdit("lean", { op: "removePhase", id: "plan" }, rev);
    const orphaned = r.workflow.descriptor.artifacts.filter((a) => !a.generates).map((a) => a.id);
    expect(orphaned, "plan.md joins the three spec-kit already ships without a producer").toContain("plan.md");
    expect(r.warnings.join(" ")).toContain('"plan.md" no longer has a phase that produces it');
  });
});

test("removePhase is REFUSED when a rule depends on it, naming who", async () => {
  // A `dependsOn` sits inside the rule DSL. Dropping it would change what the
  // surrounding condition means, and BOS does not get to decide that silently.
  await withFork("wa-remove-dependson", async () => {
    const rev = await reshape((wf) => {
      const tasks = wf.descriptor.phases.find((p) => p.id === "tasks")!;
      tasks.rules.unshift({ when: { kind: "all", of: [{ kind: "dependsOn", phase: "plan" }] }, then: "done" });
    });
    const err = await applyWorkflowEdit("lean", { op: "removePhase", id: "plan" }, rev)
      .then(() => null, (e: unknown) => e as WorkflowEditRefused);
    expect(err?.code).toBe("unsupported");
    expect(err?.message).toContain("tasks");
    expect((await readUserWorkflow("lean"))!.rev, "and nothing was written").toBe(rev);
  });
});

test("renamePhase rewrites every reference, including a NESTED dependsOn", async () => {
  await withFork("wa-rename", async () => {
    const rev = await reshape((wf) => {
      const tasks = wf.descriptor.phases.find((p) => p.id === "tasks")!;
      tasks.requires = ["plan"];
      tasks.rules.unshift({
        when: { kind: "any", of: [{ kind: "not", of: { kind: "dependsOn", phase: "plan" } }] },
        then: "blocked",
      });
    });
    const r = await applyWorkflowEdit("lean", { op: "renamePhase", id: "plan", to: "blueprint" }, rev);
    const d = r.workflow.descriptor;

    expect(d.phases.map((p) => p.id)).toContain("blueprint");
    expect(d.phases.find((p) => p.id === "tasks")?.requires).toEqual(["blueprint"]);
    expect(d.artifacts.find((a) => a.id === "plan.md")?.generates, "the artifact follows the rename").toBe("blueprint");
    expect(JSON.stringify(d.phases.find((p) => p.id === "tasks")?.rules), "the nested dependsOn too")
      .toContain('"phase":"blueprint"');
    expect(JSON.stringify(d)).not.toContain('"phase":"plan"');
  });
});

test("renamePhase does NOT move the instructions path", async () => {
  // The overlay is keyed by that path. Deriving it from the id would orphan
  // every prompt edit the user had already made to this phase.
  await withFork("wa-rename-instructions", async (rev) => {
    const before = (await readUserWorkflow("lean"))!.descriptor.phases.find((p) => p.id === "plan")?.instructions;
    expect(before, "spec-kit declares one for plan").toBeTruthy();
    const r = await applyWorkflowEdit("lean", { op: "renamePhase", id: "plan", to: "blueprint" }, rev);
    expect(r.workflow.descriptor.phases.find((p) => p.id === "blueprint")?.instructions).toBe(before);
  });
});

test("renamePhase can change only the label", async () => {
  await withFork("wa-relabel", async (rev) => {
    const r = await applyWorkflowEdit("lean", { op: "renamePhase", id: "plan", label: "Blueprint" }, rev);
    const p = r.workflow.descriptor.phases.find((x) => x.id === "plan");
    expect(p?.label).toBe("Blueprint");
    expect(p?.id, "id untouched").toBe("plan");
  });
});

test("setRequires reports the gates it ADDED", async () => {
  await withFork("wa-gate", async (rev) => {
    const r = await applyWorkflowEdit("lean", { op: "setRequires", id: "tasks", requires: ["plan"] }, rev);
    expect(r.addedGates).toEqual([{ from: "plan", to: "tasks" }]);
    expect(r.workflow.descriptor.phases.find((p) => p.id === "tasks")?.requires).toEqual(["plan"]);
  });
});

test("setRequires reports nothing added when a gate is REMOVED", async () => {
  await withFork("wa-gate-off", async () => {
    const rev = await reshape((wf) => {
      wf.descriptor.phases.find((p) => p.id === "tasks")!.requires = ["plan"];
    });
    const r = await applyWorkflowEdit("lean", { op: "setRequires", id: "tasks", requires: [] }, rev);
    expect(r.addedGates).toEqual([]);
  });
});

test("setRequires naming a phase that does not exist is refused", async () => {
  await withFork("wa-gate-ghost", async (rev) => {
    const err = await applyWorkflowEdit("lean", { op: "setRequires", id: "tasks", requires: ["ghost"] }, rev)
      .then(() => null, (e: unknown) => e as WorkflowEditRefused);
    expect(err?.code).toBe("no-such-phase");
    expect(err?.message).toContain("ghost");
  });
});

test("a gate CYCLE is caught by the validator before anything is written", async () => {
  await withFork("wa-cycle", async () => {
    const rev = await reshape((wf) => {
      wf.descriptor.phases.find((p) => p.id === "plan")!.requires = ["tasks"];
    });
    const err = await applyWorkflowEdit("lean", { op: "setRequires", id: "tasks", requires: ["plan"] }, rev)
      .then(() => null, (e: unknown) => e as WorkflowEditRefused);
    expect(err?.code).toBe("invalid");
    expect(err?.problems.map((p) => p.code)).toEqual(["cycle"]);
    expect((await readUserWorkflow("lean"))!.rev, "not written").toBe(rev);
  });
});

test("setOptional sets and clears the flag", async () => {
  await withFork("wa-optional", async (rev) => {
    const off = await applyWorkflowEdit("lean", { op: "setOptional", id: "clarify", optional: false }, rev);
    expect(off.workflow.descriptor.phases.find((p) => p.id === "clarify")?.optional).toBeUndefined();
    const on = await applyWorkflowEdit("lean", { op: "setOptional", id: "analyze", optional: true }, off.workflow.rev);
    expect(on.workflow.descriptor.phases.find((p) => p.id === "analyze")?.optional).toBe(true);
  });
});

test("setArtifacts reassigns a producer, and orphans what it took away", async () => {
  await withFork("wa-artifacts", async (rev) => {
    const r = await applyWorkflowEdit("lean", { op: "setArtifacts", id: "specify", artifacts: ["spec.md", "plan.md"] }, rev);
    const d = r.workflow.descriptor;
    expect(d.artifacts.find((a) => a.id === "plan.md")?.generates).toBe("specify");
    expect(d.artifacts.find((a) => a.id === "spec.md")?.generates).toBe("specify");
    // `plan` used to generate plan.md and now generates nothing.
    expect(d.artifacts.filter((a) => a.generates === "plan")).toEqual([]);
  });
});

test("setArtifacts will not INVENT an artifact", async () => {
  await withFork("wa-artifacts-ghost", async (rev) => {
    const err = await applyWorkflowEdit("lean", { op: "setArtifacts", id: "specify", artifacts: ["nope.md"] }, rev)
      .then(() => null, (e: unknown) => e as WorkflowEditRefused);
    expect(err?.code).toBe("unsupported");
    expect(err?.message, "says why, not just no").toContain("guess the file's scope");
  });
});

// ---------------------------------------------------------------------------
// dryRun
// ---------------------------------------------------------------------------

test("dryRun runs the same op, the same validator and the same refusals — and writes nothing", async () => {
  await withFork("wa-dry", async (rev) => {
    const preview = await applyWorkflowEdit("lean", { op: "setRequires", id: "tasks", requires: ["plan"] }, rev, { dryRun: true });
    expect(preview.preview).toBe(true);
    expect(preview.addedGates, "the consequence is computed, which is the point").toEqual([{ from: "plan", to: "tasks" }]);

    const onDisk = (await readUserWorkflow("lean"))!;
    expect(onDisk.rev, "nothing written").toBe(rev);
    expect(onDisk.descriptor.phases.find((p) => p.id === "tasks")?.requires).toEqual([]);
  });
});

test("dryRun refuses exactly what apply would refuse", async () => {
  await withFork("wa-dry-refuse", async (rev) => {
    const err = await applyWorkflowEdit("lean", { op: "setRequires", id: "tasks", requires: ["ghost"] }, rev, { dryRun: true })
      .then(() => null, (e: unknown) => e as WorkflowEditRefused);
    expect(err?.code).toBe("no-such-phase");
  });
});

// ---------------------------------------------------------------------------
// The registry sees it
// ---------------------------------------------------------------------------

test("an applied edit is visible to the running process, through the pack's own gate", async () => {
  await withFork("wa-register", async (rev) => {
    const { registerUserWorkflows } = await import("../../src/lib/specs/method/user-workflows");
    await registerUserWorkflows();
    expect(getMethod("lean")?.phases.map((p) => p.id)).not.toContain("handover");

    await applyWorkflowEdit("lean", { op: "addPhase", id: "handover", after: "specify" }, rev);
    expect(getMethod("lean")?.phases.map((p) => p.id), "no reboot needed").toContain("handover");
  });
});

test("setSkills attaches a skill to a phase — the hole that left a new phase empty forever", async () => {
  // The closed op set could add a phase and could not give it anything to run.
  // An agent could author a skill with the pack's own builder and then had no
  // way to attach it, so "+ Phase" produced a step that would never do anything.
  await withFork("wa-setskills", async (rev) => {
    const added = await applyWorkflowEdit("lean", { op: "addPhase", id: "handover", label: "Handover" }, rev);
    expect(added.workflow.descriptor.phases.find((p) => p.id === "handover")?.skills).toBeUndefined();

    const r = await applyWorkflowEdit("lean", { op: "setSkills", id: "handover", skills: ["some-new-skill"] }, added.workflow.rev);
    expect(r.workflow.descriptor.phases.find((p) => p.id === "handover")?.skills).toEqual(["some-new-skill"]);
  });
});

test("attaching a skill that is not installed yet is WARNED, not refused", async () => {
  // Declaring the phase and then building its skill is the natural order when a
  // builder is doing the work — so refusing would force the wrong sequence. But
  // an unbacked phase runs nothing, and the inspector's flag is only seen by
  // someone who opens that phase, so it is said here too.
  await withFork("wa-setskills-missing", async (rev) => {
    const r = await applyWorkflowEdit("lean", { op: "setSkills", id: "plan", skills: ["not-installed-yet"] }, rev);
    expect(r.workflow.descriptor.phases.find((p) => p.id === "plan")?.skills).toEqual(["not-installed-yet"]);
    expect(r.warnings.join(" ")).toContain("not installed");
    expect(r.warnings.join(" "), "and says what to do about it").toContain("Author it");
  });
});

test("setSkills with an empty list clears the attachment", async () => {
  await withFork("wa-setskills-clear", async (rev) => {
    const set = await applyWorkflowEdit("lean", { op: "setSkills", id: "plan", skills: ["x"] }, rev);
    const cleared = await applyWorkflowEdit("lean", { op: "setSkills", id: "plan", skills: [] }, set.workflow.rev);
    expect(cleared.workflow.descriptor.phases.find((p) => p.id === "plan")?.skills).toBeUndefined();
  });
});
