// 051 FR-021…FR-024 — a phase's instructions, and editing them.
//
// The prompt IS the phase. Structure says which steps exist; the prompt says what
// happens when one runs. Adding ui-design, design and review to spec-kit created
// three steps that tell the agent nothing — which is what made this necessary.
//   npm run test:unit -- tests/specs/phase-instructions.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { useTestDataDir } from "../services/_test-env";
import { ensureBuiltinMethod } from "../../src/lib/specs/method/resolve";
import { methodPackRoot } from "../../src/lib/specs/method/registry";
import {
  readPhaseInstructions, writePhaseInstructions, revertPhaseInstructions, defaultInstructionsRel,
} from "../../src/lib/specs/method/instructions";

test("a pack's own prompt is read, and reported as the PACK's", async () => {
  const { cleanup } = useTestDataDir("instr-pack");
  try {
    ensureBuiltinMethod();
    const i = await readPhaseInstructions("spec-kit", "plan");
    expect(i.source).toBe("pack");
    expect(i.edited).toBe(false);
    expect(i.undeclared).toBe(false);
    expect(i.rel).toBe("templates/commands/plan.md");
    expect(i.text, "the real shipped prompt").toContain("implementation planning workflow");
  } finally {
    cleanup();
  }
});

test("a phase the pack declares NO prompt for says so, and is still writable", async () => {
  // FR-024. ui-design, design and review are exactly this — they were added to
  // the pipeline and nothing was ever written for them.
  const { cleanup } = useTestDataDir("instr-undeclared");
  try {
    ensureBuiltinMethod();
    const before = await readPhaseInstructions("spec-kit", "ui-design");
    expect(before.undeclared, "the pack declares nothing").toBe(true);
    expect(before.source).toBe("none");
    expect(before.text).toBe("");

    const after = await writePhaseInstructions("spec-kit", "ui-design", "# UI Design\nProduce a mockup.\n");
    expect(after.source).toBe("overlay");
    expect(after.edited).toBe(true);
    expect(after.text).toContain("Produce a mockup");
    // BOS picks the path only in the overlay, so it cannot collide with anything
    // the pack ships or later adds.
    expect(after.rel).toBe(defaultInstructionsRel("ui-design"));
  } finally {
    cleanup();
  }
});

test("an edit NEVER touches the pack — it goes to the overlay", async () => {
  // FR-005/SC-004. The claim "we only write to the overlay" is exactly the one
  // that fails quietly, so it is asserted against the pack directory itself.
  const { dir, cleanup } = useTestDataDir("instr-not-in-pack");
  try {
    ensureBuiltinMethod();
    const packFile = join(methodPackRoot("spec-kit")!, "templates", "commands", "plan.md");
    const original = readFileSync(packFile, "utf8");

    await writePhaseInstructions("spec-kit", "plan", "MINE, not the pack's\n");

    expect(readFileSync(packFile, "utf8"), "the pack is untouched").toBe(original);
    expect(existsSync(join(dir, "method-packs", "spec-kit", "templates", "commands", "plan.md")), "the overlay has it").toBe(true);

    const i = await readPhaseInstructions("spec-kit", "plan");
    expect(i.source, "and the overlay wins on read").toBe("overlay");
    expect(i.text).toContain("MINE");
  } finally {
    cleanup();
  }
});

test("revert drops the user's copy and the pack's is in force again", async () => {
  const { cleanup } = useTestDataDir("instr-revert");
  try {
    ensureBuiltinMethod();
    await writePhaseInstructions("spec-kit", "plan", "temporary\n");
    expect((await readPhaseInstructions("spec-kit", "plan")).edited).toBe(true);

    const reverted = await revertPhaseInstructions("spec-kit", "plan");
    // Nothing is "restored" — the pack's copy was never touched, so resolution
    // simply falls through to it again.
    expect(reverted.source).toBe("pack");
    expect(reverted.edited).toBe(false);
    expect(reverted.text).toContain("implementation planning workflow");
  } finally {
    cleanup();
  }
});

test("an unknown workflow or phase is refused by NAME, not answered with an empty prompt", async () => {
  const { cleanup } = useTestDataDir("instr-unknown");
  try {
    ensureBuiltinMethod();
    await expect(readPhaseInstructions("no-such-pack", "plan")).rejects.toThrow(/no-such-pack/);
    await expect(readPhaseInstructions("spec-kit", "no-such-phase")).rejects.toThrow(/no-such-phase/);
    // An empty string would render as "this step has no instructions", which is a
    // different and wrong claim.
  } finally {
    cleanup();
  }
});

test("a rootless registration is repaired, not accepted as 'registered'", async () => {
  // Diagnosed from a real intermittent failure: `readPhaseInstructions` returned
  // source "none" for a phase whose prompt the pack certainly ships.
  //
  // `ensureBuiltinMethod` short-circuited on the descriptor being PRESENT. Any
  // caller that registers spec-kit without its pack root — several tests do, and
  // nothing stopped product code doing the same — left the registry in a state
  // where the method resolved but nothing inside the pack did: templates,
  // agentsDir and instructions all silently found nothing.
  const { cleanup } = useTestDataDir("instr-rootless");
  try {
    const { registerMethod, methodPackRoot, __resetMethodsForTest } = await import("../../src/lib/specs/method/registry");
    const { loadBuiltinDescriptor } = await import("../../src/lib/specs/method/builtin-pack");
    __resetMethodsForTest();

    // Exactly what a careless registration looks like: descriptor, no root.
    registerMethod(loadBuiltinDescriptor());
    expect(methodPackRoot("spec-kit"), "the state that used to be accepted").toBeUndefined();

    ensureBuiltinMethod();
    expect(methodPackRoot("spec-kit"), "repaired rather than short-circuited").toBeTruthy();
    expect((await readPhaseInstructions("spec-kit", "plan")).source).toBe("pack");
  } finally {
    cleanup();
  }
});
