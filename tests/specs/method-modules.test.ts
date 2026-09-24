// 048 Phase 3 — module selection (FR-006, FR-006a, FR-007, SC-002, SC-003) and
// the #999 shim (FR-009, SC-006).
//   npm run test:unit -- tests/specs/method-modules.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { useTestDataDir } from "../services/_test-env";
import { writeMethodPack, installPack } from "../../e2e/_fixtures/method-pack";
import { installMethodPack, uninstallMethodPack } from "../../src/lib/specs/method/install";
import { __resetMethodsForTest, registerMethod, getMethod } from "../../src/lib/specs/method/registry";
import { __resetPackAgentRootsForTest, agentRoots } from "../../src/lib/agent/subagents/roots";
import { listSubAgents, listDelegatableAgents } from "../../src/lib/agent/subagents/store";
import { selectModules, selectedModules, activeModules } from "../../src/lib/specs/method/modules";
import { normalizeModules, METHOD_SCHEMA_VERSION, type MethodDescriptor } from "../../src/lib/specs/method/types";

const reset = () => { __resetMethodsForTest(); __resetPackAgentRootsForTest(); };

const MODULES = [
  { id: "bmm", label: "BMad Method", default: true, requiresConfig: true, agents: ["analyst", "pm"], visibility: "delegate-only" as const },
  { id: "bmb", label: "BMad Builder", default: false, agents: ["builder"], visibility: "picker" as const },
  { id: "cis", label: "Creative Intelligence Suite", default: false, agents: ["brainstorm-coach"], visibility: "picker" as const },
];

async function installModular(dir: string) {
  const pack = writeMethodPack(dir, { packId: "bmad", label: "BMAD", modules: MODULES });
  installPack(dir, "bmad");
  return pack;
}

test("FR-006a — a 045-era `modules: string[]` still registers, with NO schemaVersion bump", () => {
  // Bumping METHOD_SCHEMA_VERSION would make registerMethod refuse every
  // existing pack, spec-kit's own method.json included, for a purely additive
  // field. The union is the whole point.
  reset();
  expect(METHOD_SCHEMA_VERSION, "048 must not touch this constant").toBe(1);
  expect(normalizeModules(["a", "b"]), "a bare string was always active").toEqual([
    { id: "a", default: true }, { id: "b", default: true },
  ]);
  expect(normalizeModules([{ id: "x", default: false }])).toEqual([{ id: "x", default: false }]);
});

test("SC-002 — BMM alone by default; +CIS adds its agents; removing CIS takes them away", async () => {
  const { dir, cleanup } = useTestDataDir("modules-selection");
  try {
    reset();
    const pack = await installModular(dir);
    const input = { itemId: "bmad", itemPath: pack.itemPath, facets: { plugin: false }, origin: "local" as const };

    // Defaults: only bmm is `default: true`.
    await installMethodPack(input);
    const defaultIds = (await listDelegatableAgents()).map((a) => a.id);
    expect(defaultIds).toEqual(expect.arrayContaining(["analyst", "pm"]));
    expect(defaultIds, "bmb/cis are not selected by default").not.toContain("brainstorm-coach");

    // Add CIS.
    reset();
    await installMethodPack(input);
    await selectModules(getMethod("bmad")!, ["bmm", "cis"]);
    reset();
    await installMethodPack(input);
    expect((await listSubAgents()).map((a) => a.id), "CIS is picker-visible").toContain("brainstorm-coach");

    // Remove it again.
    await selectModules(getMethod("bmad")!, ["bmm"]);
    reset();
    await installMethodPack(input);
    expect((await listDelegatableAgents()).map((a) => a.id)).not.toContain("brainstorm-coach");
  } finally {
    reset();
    cleanup();
  }
});

test("SC-003 / FR-007 — visibility is per MODULE: BMM hidden, CIS and BMB visible", async () => {
  const { dir, cleanup } = useTestDataDir("modules-visibility");
  try {
    reset();
    const pack = await installModular(dir);
    const input = { itemId: "bmad", itemPath: pack.itemPath, facets: { plugin: false }, origin: "local" as const };
    await installMethodPack(input);
    await selectModules(getMethod("bmad")!, ["bmm", "bmb", "cis"]);
    reset();
    await installMethodPack(input);

    const picker = (await listSubAgents()).map((a) => a.id);
    const delegatable = (await listDelegatableAgents()).map((a) => a.id);

    // BMM's cast is chain-dependent — Sally without a prd.md has no input and
    // no consumer — so it stays behind agent_delegate.
    expect(picker, "BMM is delegate-only").not.toContain("analyst");
    expect(delegatable, "…but still reachable").toContain("analyst");
    // Talking to the builder is how you use BMB; standalone facilitation is
    // CIS's stated value.
    expect(picker).toContain("builder");
    expect(picker).toContain("brainstorm-coach");
  } finally {
    reset();
    cleanup();
  }
});

test("uninstall removes EVERY module's root, not just the pack's bare id", async () => {
  // Roots are keyed `<packId>:<moduleId>`, so removing the bare packId would
  // leave each module's agents resolving from a pack that is gone.
  const { dir, cleanup } = useTestDataDir("modules-uninstall");
  try {
    reset();
    const pack = await installModular(dir);
    await installMethodPack({ itemId: "bmad", itemPath: pack.itemPath, facets: { plugin: false }, origin: "local" });
    await selectModules(getMethod("bmad")!, ["bmm", "cis"]);
    reset();
    await installMethodPack({ itemId: "bmad", itemPath: pack.itemPath, facets: { plugin: false }, origin: "local" });
    expect(agentRoots().filter((r) => r.packId?.startsWith("bmad")).length).toBeGreaterThan(1);

    await uninstallMethodPack("bmad");
    expect(agentRoots().filter((r) => r.packId?.startsWith("bmad"))).toEqual([]);
    expect((await listDelegatableAgents()).map((a) => a.id)).not.toContain("analyst");
  } finally {
    reset();
    cleanup();
  }
});

test("selecting a module the pack does not declare is DROPPED and reported, not refused", async () => {
  // This test asserted a throw until a pack removed a module and proved the
  // throw wrong. BMAD declared `bmb` and `cis` with agent directories it never
  // shipped; removing the declarations made every REINSTALL fail — the stored
  // selection still named them, the pack no longer offered them so they could
  // not be deselected, and the only way out was hand-editing
  // data/system/config/<pack>/modules.json, a file nothing surfaces.
  //
  // `selectedModules` has always dropped stale ids on READ ("an upgrade may
  // remove a module"). The write path disagreeing with the read path was the
  // bug, and the fatal one was the wrong one to keep.
  const { dir, cleanup } = useTestDataDir("modules-unknown");
  try {
    reset();
    const d: MethodDescriptor = { ...(writeMethodPack(dir, { packId: "p", modules: MODULES }).descriptor as unknown as MethodDescriptor) };
    registerMethod(d);

    const r = await selectModules(d, ["bmm", "typo"]);
    expect(r.stored, "what the pack still offers is honoured").toEqual(["bmm"]);
    expect(r.dropped, "and what it does not is NAMED, not swallowed").toEqual(["typo"]);
    expect(await selectedModules(d), "the stale id is not persisted").toEqual(["bmm"]);
  } finally {
    reset();
    cleanup();
  }
});

test("a selection left stale by a pack UPGRADE does not block reinstalling", async () => {
  // The exact reported failure: "Method \"bmad\" does not declare module(s):
  // bmb, cis. Declared: bmm."
  const { dir, cleanup } = useTestDataDir("modules-upgrade-removed");
  try {
    reset();
    const before: MethodDescriptor = { ...(writeMethodPack(dir, { packId: "p", modules: MODULES }).descriptor as unknown as MethodDescriptor) };
    registerMethod(before);
    await selectModules(before, ["bmm", "cis"]);
    expect(await selectedModules(before)).toEqual(["bmm", "cis"]);

    // The pack upgrades and drops `cis` — as BMAD did, because it never shipped
    // the agents directory that module declared.
    const after: MethodDescriptor = { ...before, modules: MODULES.filter((m) => m.id === "bmm") };
    registerMethod(after);

    // Re-selecting what the UI still has on screen must WORK.
    const r = await selectModules(after, ["bmm", "cis"]);
    expect(r.stored).toEqual(["bmm"]);
    expect(r.dropped).toEqual(["cis"]);
    expect(await selectedModules(after), "and the stale id is gone from disk").toEqual(["bmm"]);
  } finally {
    reset();
    cleanup();
  }
});

test("a module the pack STOPPED declaring is dropped from a stored selection", async () => {
  // An upgrade may remove a module; carrying the id forward would register a
  // root for a directory that is gone.
  const { dir, cleanup } = useTestDataDir("modules-dropped");
  try {
    reset();
    const d = writeMethodPack(dir, { packId: "p", modules: MODULES }).descriptor as unknown as MethodDescriptor;
    await selectModules(d, ["bmm", "cis"]);
    const upgraded: MethodDescriptor = { ...d, modules: [{ id: "bmm", default: true }] };
    expect(await selectedModules(upgraded)).toEqual(["bmm"]);
    expect((await activeModules(upgraded)).map((m) => m.id)).toEqual(["bmm"]);
  } finally {
    reset();
    cleanup();
  }
});

// The #999 shim (was T013/FR-009/SC-006) is RETIRED, not moved. Issue #999 was
// closed upstream on 2026-01-31, the buggy path shape appears nowhere in the
// current source, and the pinned range targeted 6.0.0-alpha.* against a
// 6.13.0-next upstream. A version-gated path rewrite for a fixed bug is dead on
// every version anyone would install, and the one way it can still fire is by
// misfiring — so it is deleted rather than kept "just in case".

// ---------------------------------------------------------------------------
// What bmad-pack.test.ts used to cover, kept on a FIXTURE.
//
// That file read the real BMAD pack out of seed/method-packs/bmad. The pack now
// lives in the user's own user-apps (FR-015), which BOS gitignores — so a test
// reading it would depend on deployment data, the exact dependency
// docs/dev/testing.md prohibits. Pack CONTENT tests belong with the pack.
//
// These two are about the MECHANISM, not about BMAD, so they stay here on a
// fixture that exercises the same shapes.
// ---------------------------------------------------------------------------

test("a pack persona is delegate-only yet delegatable, and carries its skills allowlist", async () => {
  const { dir, cleanup } = useTestDataDir("modules-persona-shape");
  try {
    reset();
    const pack = writeMethodPack(dir, {
      packId: "p", label: "P",
      modules: [{ id: "m", default: true, agents: ["persona"], visibility: "delegate-only" }],
    });
    installPack(dir, "p");
    await installMethodPack({ itemId: "p", itemPath: pack.itemPath, facets: { plugin: false }, origin: "local" });

    expect((await listSubAgents()).map((a) => a.id), "chain-dependent personas stay out of the picker").not.toContain("persona");
    expect((await listDelegatableAgents()).map((a) => a.id), "…but must remain reachable").toContain("persona");
  } finally {
    reset();
    cleanup();
  }
});

test("SC-011 — a sharded-artifact phase needs no framework-specific code in the pipeline", async () => {
  // The claim the design rests on. Asserted here against the GENERIC evaluator
  // rather than against BMAD's descriptor, so it keeps holding for 047/049/…
  const { evaluatePhases } = await import("../../src/lib/specs/method/evaluate");
  const d = {
    schemaVersion: 1, id: "f", label: "F", version: "1",
    sections: [{ rel: "", kind: "active" as const, leafMarker: "x.md", numbering: "none" as const }],
    constitution: "c.md", constitutionRoot: "own" as const,
    discrepancies: { rel: "d.md", roots: ["own" as const] },
    artifacts: [], artifactOrder: [],
    phases: [{
      id: "stories", label: "Stories", requires: [],
      rules: [
        { when: { kind: "set" as const, glob: "stories/*.md", quantifier: "all" as const,
                  of: { kind: "checklist" as const, file: { rel: "" }, quantifier: "all" as const } }, then: "done" as const },
        { when: { kind: "count" as const, glob: "stories/*.md", min: 1 }, then: "pending" as const },
      ],
      else: "na" as const,
    }],
    stateLabels: { done: "Done", pending: "Pending", blocked: "Blocked", na: "N/A" },
    templates: "t", agents: [], roles: {},
  };
  const unit = (files: Record<string, string>) => ({
    unitId: "u", names: Object.keys(files),
    readUnit: async (rel: string) => files[rel] ?? "", readStore: async () => "",
    glob: async (pat: string) => Object.keys(files).filter((n) => new RegExp("^" + pat.replace(/\*/g, "[^/]*") + "$").test(n)),
  });
  const st = async (f: Record<string, string>) => (await evaluatePhases(d, unit(f)))[0].state;

  expect(await st({}), "cardinality zero is not 'all complete'").toBe("na");
  expect(await st({ "stories/1.md": "- [ ] a\n" })).toBe("pending");
  expect(await st({ "stories/1.md": "- [x] a\n", "stories/2.md": "- [x] b\n" }), "a count the descriptor never named").toBe("done");
});

test("a `roles` entry naming an agent nobody provides is REPORTED", async () => {
  // Silent rot: the binding looks declared, the lookup drops it with no error,
  // and the pack simply never delegates that role. The real BMAD pack shipped
  // with four of five roles dangling — they used BMAD's SKILL ids
  // (bmad-agent-architect) while the agents on disk are keyed by persona name
  // (winston) — and nothing anywhere noticed.
  const { danglingRoles } = await import("../../src/lib/specs/method/install");
  const { dir, cleanup } = useTestDataDir("modules-dangling-roles");
  try {
    reset();
    const pack = writeMethodPack(dir, {
      packId: "p", label: "P",
      modules: [{ id: "m", default: true, agents: ["winston"], visibility: "delegate-only" }],
    });
    installPack(dir, "p");
    await installMethodPack({ itemId: "p", itemPath: pack.itemPath, facets: { plugin: false }, origin: "local" });

    const d = getMethod("p")!;
    // Checked against DELEGATABLE agents: a pack's cast is routinely
    // delegate-only, and reporting those as missing would make the signal
    // useless for exactly the packs that need it.
    expect(await danglingRoles({ ...d, roles: { architect: "winston" } }), "a real agent resolves").toEqual([]);
    expect(await danglingRoles({ ...d, roles: { architect: "bmad-agent-architect" } }))
      .toEqual([{ role: "architect", agentId: "bmad-agent-architect" }]);
  } finally {
    reset();
    cleanup();
  }
});

test("the constitution message never claims a consequence that cannot happen", async () => {
  // Reported from a live BOS: switching user-specs to BMAD said "the
  // constitution phase will report pending until one exists" — for a method
  // whose descriptor had NO constitution phase and no phase reading the
  // constitution at all. The line was written when spec-kit was the only
  // method, where one always exists.
  //
  // Asserting a consequence that cannot happen is worse than silence: it sends
  // a user to create a file nothing consults, and teaches them to discount the
  // next warning.
  const { describeConstitutionOutcome, constitutionIsRead } = await import("../../src/lib/specs/method/constitution");
  const base = {
    schemaVersion: 1, id: "m", label: "Fixture Method", version: "1",
    sections: [{ rel: "", kind: "active" as const, leafMarker: "x.md", numbering: "none" as const }],
    constitution: "docs/principles.md", constitutionRoot: "own" as const,
    discrepancies: { rel: "d.md", roots: ["own" as const] },
    artifacts: [], artifactOrder: [],
    stateLabels: { done: "Done", pending: "In progress", blocked: "Blocked", na: "N/A" },
    templates: "t", agents: [], roles: {},
  };

  const reads = { ...base, phases: [{
    id: "principles", label: "Principles", requires: [],
    rules: [{ when: { kind: "nonEmpty" as const, file: { rel: "docs/principles.md", scope: "store" as const } }, then: "done" as const }],
    else: "pending" as const,
  }] };
  const ignores = { ...base, phases: [{ id: "brief", label: "Brief", requires: [], rules: [], else: "pending" as const }] };

  expect(constitutionIsRead(reads)).toBe(true);
  expect(constitutionIsRead(ignores)).toBe(false);

  const absent = { kind: "absent" as const, expectedAt: "user-specs/docs/principles.md" };
  const whenRead = describeConstitutionOutcome(absent, reads);
  expect(whenRead, "names the real phase").toContain('"Principles"');
  expect(whenRead, "and that method's OWN label for pending").toContain("In progress");

  const whenNot = describeConstitutionOutcome(absent, ignores);
  expect(whenNot, "says plainly that nothing consults it").toMatch(/does not read one/);
  // The correct sentence legitimately contains "nothing will report it
  // missing" — so assert on what actually matters: no phase is NAMED, and no
  // pending state is claimed.
  expect(whenNot, "must not name a phase that does not exist").not.toMatch(/The ".+" phase/);
  expect(whenNot, "must not claim a pending state").not.toContain("In progress");
});
