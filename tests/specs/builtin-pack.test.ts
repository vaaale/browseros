// 046 T005 — the built-in pack registers like any other, and refuses uninstall
// (FR-001, FR-008, FR-009, SC-004, SC-005).
//   npm run test:unit -- tests/specs/builtin-pack.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { useTestDataDir } from "../services/_test-env";
import { registerBuiltinPack, builtinPackRoot, loadBuiltinDescriptor } from "../../src/lib/specs/method/builtin-pack";
import { getMethod, methodPackRoot, __resetMethodsForTest } from "../../src/lib/specs/method/registry";
import { uninstallMethodPack, BuiltinMethodUninstallError } from "../../src/lib/specs/method/install";
import { ensureBuiltinMethod } from "../../src/lib/specs/method/resolve";
import { __resetPackAgentRootsForTest, agentRoots } from "../../src/lib/agent/subagents/roots";
import { listSubAgents } from "../../src/lib/agent/subagents/store";

test("SC-005 — the pack reaches registration through the SAME sequence a marketplace pack does", async () => {
  // Asserted by FOLLOWING the sequence, not by grepping for `builtin` — FR-001
  // makes `builtin` a legitimate descriptor field, so its presence proves
  // nothing either way. What matters is that registration records a pack root
  // and an agent root exactly as installMethodPack does.
  __resetMethodsForTest();
  __resetPackAgentRootsForTest();

  const manifest = await registerBuiltinPack();

  expect(getMethod("spec-kit")?.id).toBe("spec-kit");
  expect(methodPackRoot("spec-kit"), "pack-relative paths resolve against the pack, not BOS's tree").toBe(builtinPackRoot());
  expect(agentRoots().some((r) => r.packId === "spec-kit"), "the pack contributes an agent root").toBe(true);
  expect(manifest.templates, "templates are pack-relative, like any pack's").toBe("templates");
});

test("SC-004 — a builtin pack refuses uninstall, naming its dependant", async () => {
  __resetMethodsForTest();
  await registerBuiltinPack();

  let err: Error | undefined;
  try {
    await uninstallMethodPack("spec-kit");
  } catch (e) {
    err = e as Error;
  }
  expect(err).toBeInstanceOf(BuiltinMethodUninstallError);
  expect(err!.message, "names bos-system-specs as the dependant").toContain("bos-system-specs");
  expect(getMethod("spec-kit"), "and nothing is unregistered").toBeDefined();
});

test("registration happens BEFORE the first store read (ensureStoresOnce has several entry points)", () => {
  // The Edge Case in the spec. A store read that races registration renders an
  // EMPTY store, which reads as data loss rather than as a boot-order bug —
  // so resolution self-heals rather than depending on instrumentation order.
  __resetMethodsForTest();
  expect(getMethod("spec-kit")).toBeUndefined();
  ensureBuiltinMethod();
  expect(getMethod("spec-kit"), "any resolution path registers the pack on demand").toBeDefined();
});

test("the descriptor is the pack's method.json — no TS module survives as a fallback", () => {
  // T006. A surviving fallback would move the two-code-paths problem rather
  // than remove it: it is what gets read whenever the pack fails to load,
  // which is exactly when the failure should be heard.
  expect(existsSync("src/lib/specs/method/spec-kit.ts"), "the TS descriptor must be gone").toBe(false);
  expect(existsSync(join(builtinPackRoot(), "method.json"))).toBe(true);

  const onDisk = JSON.parse(readFileSync(join(builtinPackRoot(), "method.json"), "utf8"));
  const loaded = loadBuiltinDescriptor();
  expect(loaded.id).toBe(onDisk.id);
  expect(loaded.phases).toHaveLength(12); // 051 added ui-design, design and review
  // The invariants 045's parity depends on, re-asserted against the RELOCATED
  // descriptor: any edge makes `blocked` reachable and flips 120 live features.
  expect(loaded.phases.filter((p) => p.requires.length > 0)).toEqual([]);
  expect(loaded.artifactOrder).not.toContain("design.md");
  expect(loaded.constitutionRoot, "moving the pack must not move the constitution").toBe("system");
  expect(loaded.constitution).toBe(".specify/memory/constitution.md");
});

test("the pack's agents are DISCOVERED from its root, not copied into data/agents/", async () => {
  const { dir, cleanup } = useTestDataDir("builtin-pack-agents");
  try {
    __resetMethodsForTest();
    __resetPackAgentRootsForTest();
    await registerBuiltinPack();

    const ids = (await listSubAgents()).map((a) => a.id);
    // After T007 the four process agents live only in the pack.
    for (const id of ["architect", "architect-reviewer", "ui-designer", "devil-s-advocate"]) {
      expect(ids, `${id} must resolve from the pack root`).toContain(id);
      expect(existsSync(join(dir, "agents", id)), `${id} must NOT be copied into data/agents/`).toBe(false);
    }
  } finally {
    __resetPackAgentRootsForTest();
    cleanup();
  }
});
