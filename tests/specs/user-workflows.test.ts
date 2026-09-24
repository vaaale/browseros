// 051 T007-T009 — a workflow the user owns.
//
// A fork is for "a NEW NAMED workflow, bound to these repos only". Changing a
// pack's own content everywhere is the OVERLAY's job (Phase 1b) and needs no
// fork at all — the distinction matters, because reaching for a fork to tweak a
// prompt means never receiving the pack's improvements again.
//   npm run test:unit -- tests/specs/user-workflows.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { useTestDataDir } from "../services/_test-env";
import { ensureBuiltinMethod } from "../../src/lib/specs/method/resolve";
import { getMethod, listMethods, registerMethod, __resetMethodsForTest, methodPackRoot } from "../../src/lib/specs/method/registry";
import { loadBuiltinDescriptor } from "../../src/lib/specs/method/builtin-pack";
import {
  forkWorkflow, readUserWorkflow, listUserWorkflowIds, deleteUserWorkflow,
  registerUserWorkflows, userWorkflowsRoot,
} from "../../src/lib/specs/method/user-workflows";
import type { MethodDescriptor } from "../../src/lib/specs/method/types";

const SPEC_KIT = loadBuiltinDescriptor() as MethodDescriptor;

test("a fork copies the RESOLVED descriptor and records where it came from", async () => {
  const { cleanup } = useTestDataDir("uw-fork");
  try {
    ensureBuiltinMethod();
    const wf = await forkWorkflow("spec-kit", "lean", "Lean");
    expect(wf.kind).toBe("fork");
    if (wf.kind !== "fork") throw new Error("unreachable");

    expect(wf.from).toBe("spec-kit");
    expect(wf.fromVersion, "the version it was taken at, for drift reporting only").toBe(SPEC_KIT.version);
    expect(wf.descriptor.id, "its own id, not the source's").toBe("lean");
    expect(wf.descriptor.label).toBe("Lean");
    expect(wf.descriptor.builtin, "a fork is never builtin, whatever it came from").toBe(false);
    expect(wf.descriptor.phases).toHaveLength(SPEC_KIT.phases.length);
    expect(wf.rev).toBe(1);
  } finally {
    cleanup();
  }
});

test("a fork owes NOTHING to its source — it survives the pack vanishing", async () => {
  // SC-001. This is the property that distinguishes a fork from an override, and
  // the reason `from` is for reporting only and never for resolution.
  const { cleanup } = useTestDataDir("uw-independent");
  try {
    ensureBuiltinMethod();
    await forkWorkflow("spec-kit", "lean");

    // The source disappears entirely.
    __resetMethodsForTest();
    expect(getMethod("spec-kit"), "the pack is gone").toBeUndefined();

    const { registered, failed } = await registerUserWorkflows();
    expect(registered, "the fork registers anyway").toEqual(["lean"]);
    expect(failed).toEqual({});
    expect(getMethod("lean")?.phases.length).toBe(SPEC_KIT.phases.length);
  } finally {
    __resetMethodsForTest();
    cleanup();
  }
});

test("a fork goes through the SAME registration gate a pack does", async () => {
  // R1: user-editable data reaching a gate built for pack data. A fork is not
  // privileged for being local.
  const { cleanup } = useTestDataDir("uw-gate");
  try {
    ensureBuiltinMethod();
    await forkWorkflow("spec-kit", "broken");

    // Corrupt it the way a hand-edit would: strip the storeRoot the gate requires.
    const file = join(userWorkflowsRoot(), "broken", "workflow.json");
    const wf = JSON.parse(readFileSync(file, "utf8"));
    delete wf.descriptor.storeRoot;
    writeFileSync(file, JSON.stringify(wf));

    const { registered, failed } = await registerUserWorkflows();
    expect(registered).toEqual([]);
    expect(failed.broken, "named, with the gate's own reason").toMatch(/storeRoot/);
    expect(getMethod("broken"), "and nothing half-registers").toBeUndefined();
  } finally {
    cleanup();
  }
});

test("ONE broken workflow does not take the others down with it", async () => {
  // The failure mode that matters: every store bound to a workflow would stop
  // resolving because of one unrelated malformed file.
  const { cleanup } = useTestDataDir("uw-contained");
  try {
    ensureBuiltinMethod();
    await forkWorkflow("spec-kit", "good-one");
    await forkWorkflow("spec-kit", "bad-one");
    writeFileSync(join(userWorkflowsRoot(), "bad-one", "workflow.json"), "{ not json");

    const { registered, failed } = await registerUserWorkflows();
    expect(registered).toEqual(["good-one"]);
    expect(Object.keys(failed)).toEqual(["bad-one"]);
  } finally {
    cleanup();
  }
});

test("a fork that collides with a pack is REPORTED, never resolved by order", async () => {
  // 049 FR-004's rule. Silently letting either win means a pack upgrade can
  // replace the user's workflow, or be replaced by it, with no signal.
  const { cleanup } = useTestDataDir("uw-collide");
  try {
    ensureBuiltinMethod();
    // Fork under a free name, then have a pack take that name afterwards.
    await forkWorkflow("spec-kit", "contested");
    registerMethod({ ...SPEC_KIT, id: "contested", label: "A pack's own" });

    const { registered, failed } = await registerUserWorkflows();
    expect(registered).toEqual([]);
    expect(failed.contested).toMatch(/already provides/);
    expect(getMethod("contested")?.label, "the pack's stays in force").toBe("A pack's own");
  } finally {
    __resetMethodsForTest();
    cleanup();
  }
});

test("forking is refused rather than overwriting, and ids are validated", async () => {
  const { cleanup } = useTestDataDir("uw-refuse");
  try {
    ensureBuiltinMethod();
    await forkWorkflow("spec-kit", "taken");
    await expect(forkWorkflow("spec-kit", "taken")).rejects.toThrow(/already exists/);
    await expect(forkWorkflow("spec-kit", "spec-kit"), "a pack's name").rejects.toThrow(/already exists/);
    await expect(forkWorkflow("no-such", "x")).rejects.toThrow(/No workflow "no-such"/);
    for (const bad of ["../escape", "Has Caps", ""]) {
      await expect(forkWorkflow("spec-kit", bad), bad).rejects.toThrow(/not a valid workflow id/);
    }
  } finally {
    cleanup();
  }
});

test("a fork carries the customisations you had made to its source", async () => {
  // A fork is a snapshot of WHAT YOU WERE LOOKING AT, and that includes your own
  // edits. Before this, the descriptor was copied resolved — so structural
  // changes carried — while file-level ones did not: every customised prompt
  // silently reverted to the pack's original. Half the customisation survived.
  const { cleanup } = useTestDataDir("uw-fork-overlay");
  try {
    ensureBuiltinMethod();
    const { writePhaseInstructions, readPhaseInstructions } = await import("../../src/lib/specs/method/instructions");
    await writePhaseInstructions("spec-kit", "plan", "MY PLAN PROMPT\n");

    await forkWorkflow("spec-kit", "snapshot");
    await registerUserWorkflows();

    const onFork = await readPhaseInstructions("snapshot", "plan");
    expect(onFork.text, "the fork has what you were looking at").toContain("MY PLAN PROMPT");
    expect(onFork.source).toBe("overlay");

    // COPIED, not chained: changing the source afterwards must not reach the
    // snapshot, or a fork would not owe nothing to its source.
    await writePhaseInstructions("spec-kit", "plan", "CHANGED AFTERWARDS\n");
    expect((await readPhaseInstructions("snapshot", "plan")).text).toContain("MY PLAN PROMPT");
    expect((await readPhaseInstructions("spec-kit", "plan")).text).toContain("CHANGED AFTERWARDS");
  } finally {
    cleanup();
  }
});

test("deleting a fork removes the copy and leaves the source pack alone", async () => {
  const { cleanup } = useTestDataDir("uw-delete");
  try {
    ensureBuiltinMethod();
    const packRoot = methodPackRoot("spec-kit")!;
    const before = readFileSync(join(packRoot, "method.json"), "utf8");

    await forkWorkflow("spec-kit", "temp");
    expect(await listUserWorkflowIds()).toEqual(["temp"]);
    await deleteUserWorkflow("temp");

    expect(await listUserWorkflowIds()).toEqual([]);
    expect(await readUserWorkflow("temp")).toBeNull();
    expect(readFileSync(join(packRoot, "method.json"), "utf8"), "the pack is untouched").toBe(before);
  } finally {
    cleanup();
  }
});

test("nothing is written inside the pack, ever (SC-004)", async () => {
  const { dir, cleanup } = useTestDataDir("uw-not-in-pack");
  try {
    ensureBuiltinMethod();
    // Captured BEFORE the fork, and asserted rather than `!`-ed: the registry is
    // process-wide and shared across test files, so an absent pack root must read
    // as "the registry was empty" and not as a TypeError inside path.join.
    const packRoot = methodPackRoot("spec-kit");
    expect(packRoot, "spec-kit must be registered for this assertion to mean anything").toBeTruthy();

    await forkWorkflow("spec-kit", "mine");
    expect(existsSync(join(dir, "workflows", "mine", "workflow.json")), "lives under data/workflows").toBe(true);
    // The pack directory is BOS source; a fork must not have reached into it.
    expect(existsSync(join(packRoot!, "workflows")), "no stray dir in the pack").toBe(false);
  } finally {
    cleanup();
  }
});

test("an absent workflows/ directory is a normal empty state, not an error", async () => {
  const { cleanup } = useTestDataDir("uw-empty");
  try {
    ensureBuiltinMethod();
    expect(await listUserWorkflowIds()).toEqual([]);
    expect(await registerUserWorkflows()).toEqual({ registered: [], failed: {} });
    mkdirSync(userWorkflowsRoot(), { recursive: true });
    expect(await listUserWorkflowIds()).toEqual([]);
  } finally {
    cleanup();
  }
});

test("registration is idempotent and the fork appears in listMethods", async () => {
  const { cleanup } = useTestDataDir("uw-idempotent");
  try {
    ensureBuiltinMethod();
    await forkWorkflow("spec-kit", "twice");
    await registerUserWorkflows();
    await registerUserWorkflows();
    expect(listMethods().filter((m) => m.id === "twice")).toHaveLength(1);
  } finally {
    __resetMethodsForTest();
    cleanup();
  }
});

test("the registration pass is memoized PER DATA ROOT, not per process", async () => {
  // The defect this guards is the one `reconcileInstalledItemAssets` and the
  // agent store's `seededRoots` were each fixed for, and it got worse when user
  // workflows joined the pass: they live under `data/`, so a process-wide memo
  // carried one root's forks into another root's registry. In a test run that
  // means whichever file ran first decided what every later one saw.
  const { ensureInstalledMethodPacks } = await import("../../src/lib/specs/method/install");

  const a = useTestDataDir("uw-root-a");
  try {
    ensureBuiltinMethod();
    await forkWorkflow("spec-kit", "only-in-a");
    __resetMethodsForTest();
    ensureBuiltinMethod();
    expect(await ensureInstalledMethodPacks()).toContain("only-in-a");
  } finally {
    a.cleanup();
  }

  const b = useTestDataDir("uw-root-b");
  try {
    ensureBuiltinMethod();
    // A DIFFERENT data root, with no forks in it at all.
    __resetMethodsForTest();
    ensureBuiltinMethod();
    const got = await ensureInstalledMethodPacks();
    expect(got, "root B must not inherit root A's fork").not.toContain("only-in-a");
    expect(getMethod("only-in-a"), "and it must not be registered here").toBeUndefined();
  } finally {
    __resetMethodsForTest();
    b.cleanup();
  }
});

test("a fork reports what the user changed, separably from what the base said", async () => {
  // The delta, DERIVED rather than authored. This is what makes the fork model
  // workable without a patch format: an upgrade is "re-fork and re-apply", and
  // re-applying needs to know precisely what to re-apply.
  const { cleanup } = useTestDataDir("uw-status");
  try {
    ensureBuiltinMethod();
    const { forkStatus } = await import("../../src/lib/specs/method/user-workflows");
    await forkWorkflow("spec-kit", "trimmed");

    // Edit the fork the way the canvas will: drop a phase, add one.
    const file = join(userWorkflowsRoot(), "trimmed", "workflow.json");
    const wf = JSON.parse(readFileSync(file, "utf8"));
    wf.descriptor.phases = wf.descriptor.phases.filter((p: { id: string }) => p.id !== "analyze");
    wf.descriptor.phases.push({ id: "signoff", label: "Signoff", requires: [], rules: [], else: "na" });
    writeFileSync(file, JSON.stringify(wf));

    const st = (await forkStatus("trimmed"))!;
    expect(st.changedPhases.removed, "computed against the BASELINE, not the source's current phases").toEqual(["analyze"]);
    expect(st.changedPhases.added).toEqual(["signoff"]);
    expect(st.behind, "same version — nothing to upgrade to").toBe(false);
    expect(st.currentVersion).toBe(st.fromVersion);
  } finally {
    cleanup();
  }
});

test("a newer base is REPORTED so a fork is not a silent freeze", async () => {
  const { cleanup } = useTestDataDir("uw-behind");
  try {
    ensureBuiltinMethod();
    const { forkStatus } = await import("../../src/lib/specs/method/user-workflows");
    await forkWorkflow("spec-kit", "old");

    // The pack ships a new version underneath the fork.
    registerMethod({ ...SPEC_KIT, version: "99.0.0" });
    const st = (await forkStatus("old"))!;
    expect(st.behind).toBe(true);
    expect(st.currentVersion).toBe("99.0.0");
    expect(st.fromVersion, "and the fork still knows what it was taken at").toBe(SPEC_KIT.version);
  } finally {
    __resetMethodsForTest();
    cleanup();
  }
});

test("a fork whose source pack is gone reports that, and is not an error", async () => {
  const { cleanup } = useTestDataDir("uw-source-gone");
  try {
    ensureBuiltinMethod();
    const { forkStatus } = await import("../../src/lib/specs/method/user-workflows");
    await forkWorkflow("spec-kit", "orphan");
    __resetMethodsForTest();

    const st = (await forkStatus("orphan"))!;
    expect(st.currentVersion, "nothing to compare against").toBeNull();
    expect(st.behind, "and therefore not 'behind' — there is no newer base").toBe(false);
  } finally {
    __resetMethodsForTest();
    cleanup();
  }
});

test("a fork REFUSES rather than silently dropping customisations it cannot read", async () => {
  // Written after this exact function shipped with `catch { return; }`, one
  // commit after the bug it exists to prevent. An unreadable overlay would have
  // been treated as "nothing customised", so the fork would quietly lose the
  // user's prompts — the same harm, arrived at a different way.
  const { cleanup } = useTestDataDir("uw-overlay-unreadable");
  try {
    ensureBuiltinMethod();
    const { writePhaseInstructions } = await import("../../src/lib/specs/method/instructions");
    const { packOverlayDir } = await import("../../src/lib/specs/method/overlay");
    const { chmod } = await import("fs/promises");

    await writePhaseInstructions("spec-kit", "plan", "MINE\n");
    const overlay = packOverlayDir("spec-kit");
    await chmod(overlay, 0o000);
    try {
      await expect(forkWorkflow("spec-kit", "doomed")).rejects.toThrow(/would silently lose them/);
    } finally {
      await chmod(overlay, 0o755);
    }

    // ENOENT stays silent, because "nothing customised" is the normal case.
    const { cleanup: c2 } = useTestDataDir("uw-overlay-absent");
    try {
      ensureBuiltinMethod();
      await expect(forkWorkflow("spec-kit", "fine")).resolves.toBeTruthy();
    } finally {
      c2();
    }
  } finally {
    cleanup();
  }
});
