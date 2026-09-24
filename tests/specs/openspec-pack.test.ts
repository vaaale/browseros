// 047 — the OpenSpec pack, and therefore the acceptance test for 045.
//
// 047's whole premise is that a SECOND framework needs no BOS code. This file
// is written FIRST, against an OpenSpec-shaped fixture, precisely to find where
// that premise is false — and 047's own Assumptions say failures found here are
// 045 bugs to fix, not pack quirks to work around.
//
// The fixture is built at test time (FR-013). It must never depend on a
// pre-seeded store or on the real pack being installed: a test that needs live
// data is green only on the machine that captured it.
//   npm run test:unit -- tests/specs/openspec-pack.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { useTestDataDir } from "../services/_test-env";
import { specsRoot } from "../../src/os/specs-dir";
import { ensureStores } from "../../src/lib/specs/seed";
import { registerMethod, __resetMethodsForTest } from "../../src/lib/specs/method/registry";
import { loadBuiltinDescriptor } from "../../src/lib/specs/method/builtin-pack";
import { specTree, listSpecifications, nextFeatureId, assertEditablePath } from "../../src/lib/specs/pipeline";
import type { MethodDescriptor } from "../../src/lib/specs/method/types";

const SPEC_KIT = loadBuiltinDescriptor();

function write(root: string, rel: string, body: string): void {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
}

/** OpenSpec's real shape: two live trees plus an archive, named changes, and a
 *  DAG whose edges are ENABLERS — `specs` and `design` are parallel after
 *  `proposal`. Kept faithful to 047 FR-001/FR-003 rather than simplified, since
 *  the simplifications are exactly what would hide the gaps. */
const OPENSPEC: MethodDescriptor = {
  schemaVersion: 1,
  id: "openspec",
  label: "OpenSpec",
  // Pinned to the verified upstream (Fission-AI/openspec@9d4e597). An earlier
  // draft carried an invented "0.9.0"; T002 must ship the real one.
  version: "1.13.0",
  sections: [
    { rel: "changes", kind: "active", leafMarker: "proposal.md", numbering: "none" },
    { rel: "specs", kind: "truth", leafMarker: "spec.md", numbering: "none" },
    { rel: "changes/archive", kind: "archive", leafMarker: "proposal.md", numbering: "none", terminal: true, terminalLabel: "Archived" },
  ],
  // v1.13 keeps project context in config.yaml; project.md is LEGACY —
  // legacy-cleanup.ts detects it only to say it needs manual migration.
  constitution: "config.yaml",
  constitutionRoot: "own",
  discrepancies: { rel: "discrepancies.md", roots: ["own"] },
  artifacts: [
    { id: "proposal.md", generates: "proposal", requires: [] },
    { id: "specs", generates: "specs", requires: ["proposal"], scope: "unit" },
    { id: "design.md", generates: "design", requires: ["proposal"] },
    { id: "tasks.md", generates: "tasks", requires: ["specs", "design"] },
  ],
  // No `apply` entry: it generates no file, and artifactOrder sorts FILE NAMES.
  artifactOrder: ["proposal.md", "specs", "design.md", "tasks.md"],
  phases: [
    { id: "proposal", label: "Proposal", requires: [], rules: [{ when: { kind: "nonEmpty", file: { rel: "proposal.md" } }, then: "done" }] },
    // Enablers, not gates: once the proposal exists these are AVAILABLE. They
    // are expressed as `pending` — the STATE ids stay fixed so parity is
    // expressible — and renamed via stateLabels (047 design §3.5).
    { id: "specs", label: "Delta specs", requires: ["proposal"], rules: [{ when: { kind: "count", glob: "specs/**/*.md", min: 1 }, then: "done" }] },
    { id: "design", label: "Design", requires: ["proposal"], rules: [{ when: { kind: "nonEmpty", file: { rel: "design.md" } }, then: "done" }] },
    // `tasks` means PLANNED; `apply` means BUILT. Upstream draws this line by
    // putting `apply` outside its `artifacts:` list — it has requires/tracks but
    // no `generates`, because executing a plan produces no new artifact.
    //
    // Folding both into one phase (checklist-all on tasks.md) reports a
    // complete, well-written tasks.md with nothing ticked as "Available", i.e.
    // as an artifact still owed — and leaves execution progress with no chip at
    // all, which is the one signal worth watching.
    { id: "tasks", label: "Tasks", requires: ["specs", "design"], rules: [{ when: { kind: "nonEmpty", file: { rel: "tasks.md" } }, then: "done" }] },
    { id: "apply", label: "Apply", requires: ["tasks"], rules: [{ when: { kind: "checklist", file: { rel: "tasks.md" }, quantifier: "all" }, then: "done" }] },
  ],
  stateLabels: { done: "Done", pending: "Available", blocked: "Blocked", na: "—" },
  templates: "templates",
  // Where OpenSpec keeps specs inside a user's repository — the same value the
  // shipped pack declares, because its own CLI must find them (050 FR-003).
  storeRoot: "openspec",
  agents: [],
  roles: {},
};

/** A store laid out the way OpenSpec lays one out. Deliberately NOT a BOS
 *  Project layout: `changes/` and `specs/` are SECTIONS declared by the
 *  descriptor, and whether BOS can discover units under them without a
 *  project.json is the question this file exists to answer. */
async function openspecStore(): Promise<string> {
  await ensureStores();
  const root = join(specsRoot(), "user-specs");
  const manifest = JSON.parse(readFileSync(join(root, "spec-store.json"), "utf8"));
  writeFileSync(join(root, "spec-store.json"), JSON.stringify({ ...manifest, method: "openspec" }, null, 2));

  write(root, "config.yaml", "schema: spec-driven\ncontext: |\n  OpenSpec's constitution equivalent.\n");
  // An active change with ONLY a proposal — the parallel-artifact case.
  write(root, "changes/add-dark-mode/proposal.md", "# Add dark mode\n\nWhy this exists.\n");
  // Current truth.
  write(root, "specs/auth/spec.md", "# Auth\n\nHow the system behaves today.\n");
  // History.
  write(root, "changes/archive/2026-01-01-add-login/proposal.md", "# Add login\n\nShipped.\n");
  write(root, "changes/archive/2026-01-01-add-login/tasks.md", "- [x] done\n");
  return root;
}

test("BOS must not RESTRUCTURE a store whose method owns the store root", async () => {
  // The 033 Project migration renames every top-level directory of a store into
  // a default `user/` Project and COMMITS it, on every boot, unless some
  // top-level dir already owns a project.json.
  //
  // OpenSpec declares its sections AT the store root — `changes/` and `specs/`.
  // So adopting it means BOS silently moves the user's two trees to
  // `user/changes/` and `user/specs/`, where the descriptor cannot find them:
  // the store empties, and the cause is a rename committed by a migration that
  // ran before anything was displayed. This is a destructive 045x033
  // interaction, not a pack quirk — which is exactly what 047 exists to find.
  const { cleanup } = useTestDataDir("openspec-no-restructure");
  try {
    __resetMethodsForTest();
    registerMethod(SPEC_KIT);
    registerMethod(OPENSPEC);
    const root = await openspecStore();

    // ensureStoresOnce() runs the migration; listSpecifications triggers it.
    await listSpecifications();

    expect(existsSync(join(root, "changes", "add-dark-mode", "proposal.md")), "the change stays where OpenSpec put it").toBe(true);
    expect(existsSync(join(root, "specs", "auth", "spec.md")), "the specs tree stays at the store root").toBe(true);
    expect(existsSync(join(root, "user", "changes")), "BOS must not invent a Project around a method-owned root").toBe(false);
  } finally {
    __resetMethodsForTest();
    cleanup();
  }
});

test("SC-002 — a named change with no NNN- prefix is DISCOVERED", async () => {
  const { cleanup } = useTestDataDir("openspec-discovery");
  try {
    __resetMethodsForTest();
    registerMethod(SPEC_KIT);
    registerMethod(OPENSPEC);
    await openspecStore();

    const specs = await listSpecifications();
    const paths = specs.filter((s) => s.store === "user-specs").map((s) => s.path).sort();
    expect(paths, "all three sections contribute units").toEqual([
      "user-specs/changes/add-dark-mode",
      "user-specs/changes/archive/2026-01-01-add-login",
      "user-specs/specs/auth",
    ]);
  } finally {
    __resetMethodsForTest();
    cleanup();
  }
});

test("SC-003 — `specs` and `design` are simultaneously available after the proposal", async () => {
  const { cleanup } = useTestDataDir("openspec-parallel");
  try {
    __resetMethodsForTest();
    registerMethod(SPEC_KIT);
    registerMethod(OPENSPEC);
    await openspecStore();

    const change = (await listSpecifications()).find((s) => s.path === "user-specs/changes/add-dark-mode");
    expect(change, "the change must be discovered before its phases mean anything").toBeDefined();
    const byId = Object.fromEntries((change!.phases ?? []).map((p) => [p.id, p.state]));

    expect(byId.proposal).toBe("done");
    // Enablers, not gates. Neither is owed; both are offered.
    expect(byId.specs, "parallel with design").toBe("pending");
    expect(byId.design, "parallel with specs").toBe("pending");
    expect(byId.tasks, "genuinely unreachable — both its edges are unmet").toBe("blocked");
  } finally {
    __resetMethodsForTest();
    cleanup();
  }
});

test("SC-004 — an ARCHIVED change renders terminal, not live", async () => {
  // A change under changes/archive/ is history. Evaluating the DAG against it
  // advertises "tasks: available" for work finished months ago, which invites
  // someone to edit frozen history believing it is open work.
  const { cleanup } = useTestDataDir("openspec-archive");
  try {
    __resetMethodsForTest();
    registerMethod(SPEC_KIT);
    registerMethod(OPENSPEC);
    await openspecStore();

    const archived = (await listSpecifications()).find((s) => s.path.includes("/archive/"));
    expect(archived, "archived changes are still discoverable").toBeDefined();
    const states = new Set((archived!.phases ?? []).map((p) => p.state));
    expect([...states], "no live state on frozen history").toEqual(["na"]);
  } finally {
    __resetMethodsForTest();
    cleanup();
  }
});

test("US4 — the three sections are distinguishable in the tree", async () => {
  const { cleanup } = useTestDataDir("openspec-tree");
  try {
    __resetMethodsForTest();
    registerMethod(SPEC_KIT);
    registerMethod(OPENSPEC);
    await openspecStore();

    const group = (await specTree()).find((g) => g.name === "user-specs");
    const children = group?.children ?? [];
    expect(children.map((n) => n.name).sort(), "changes/ and specs/ both render").toEqual(["changes", "specs"]);

    // Each carries its KIND, so the UI can say which of the three a user is
    // looking at. Without it someone edits current truth believing it is a
    // proposal — a correctness problem, not a cosmetic one.
    const byName = Object.fromEntries(children.map((n) => [n.name, n]));
    expect(byName.changes?.sectionKind).toBe("active");
    expect(byName.specs?.sectionKind).toBe("truth");

    // The archive is NESTED inside changes/ (that is where it lives on disk) and
    // must be tagged there, not hoisted to the top level and rendered twice.
    const archive = (byName.changes?.children ?? []).find((n) => n.name === "archive");
    expect(archive?.sectionKind, "a nested section is labelled by the same rule").toBe("archive");
    expect(archive?.terminal).toBe(true);
    expect(children.some((n) => n.name === "archive"), "not also hoisted to the top level").toBe(false);
  } finally {
    __resetMethodsForTest();
    cleanup();
  }
});

test("SC-002 — nextFeatureId allocates NO numeric prefix under numbering:none", async () => {
  const { cleanup } = useTestDataDir("openspec-numbering");
  try {
    __resetMethodsForTest();
    registerMethod(SPEC_KIT);
    registerMethod(OPENSPEC);
    await openspecStore();

    const id = await nextFeatureId("Add search", "user-specs/changes");
    expect(id, "a change is named, not numbered").toBe("user-specs/changes/add-search");
  } finally {
    __resetMethodsForTest();
    cleanup();
  }
});

test("a REBOUND store allocates ids under its new method, without a restart", async () => {
  // methodCache is a module global that outlives the binding it caches, and
  // only listSpecifications/getSpecification ever cleared it. So a store
  // rebound to a `numbering: "none"` method kept allocating NNN- prefixes (and
  // vice versa) through nextFeatureId and specTree — until some unrelated call
  // happened to clear the cache for it.
  //
  // It showed up first as a "flaky" test: project-layer's numbering assertion
  // failed only when its worker had already run a test that bound a different
  // method to the same store id. Same-process staleness, not load.
  const { cleanup } = useTestDataDir("openspec-rebind");
  try {
    __resetMethodsForTest();
    registerMethod(SPEC_KIT);
    registerMethod(OPENSPEC);
    const root = await openspecStore();

    expect(await nextFeatureId("Add search", "user-specs/changes")).toBe("user-specs/changes/add-search");

    // Rebind to spec-kit in the SAME process — no restart, no cache reset.
    const manifest = JSON.parse(readFileSync(join(root, "spec-store.json"), "utf8"));
    writeFileSync(join(root, "spec-store.json"), JSON.stringify({ ...manifest, method: "spec-kit" }, null, 2));
    write(root, "alpha/project.json", JSON.stringify({ label: "Alpha" }));

    expect(await nextFeatureId("Add search", "user-specs/alpha"), "spec-kit numbers its features").toBe("user-specs/alpha/001-add-search");
  } finally {
    __resetMethodsForTest();
    cleanup();
  }
});

test("SC-003 (control) — delta specs INSIDE a change are actually seen by the glob", async () => {
  // The parallel-availability test above asserts `specs: pending` with no delta
  // specs written. That passes whether the glob works or is structurally unable
  // to match anything — so on its own it proves nothing about `set`/`count`.
  //
  // This is the case that distinguishes them: write the delta specs and require
  // the phase to go `done`. 045's set/count predicate exists for exactly this
  // (a glob whose cardinality is unknown when the descriptor is written), and
  // BMAD's shipped `stories` phase depends on it too.
  const { cleanup } = useTestDataDir("openspec-glob");
  try {
    __resetMethodsForTest();
    registerMethod(SPEC_KIT);
    registerMethod(OPENSPEC);
    const root = await openspecStore();
    // Delta specs live NESTED inside the change, not beside proposal.md.
    write(root, "changes/add-dark-mode/specs/ui/spec.md", "## ADDED\n\nDark mode toggle.\n");

    const change = (await listSpecifications()).find((s) => s.path === "user-specs/changes/add-dark-mode");
    const byId = Object.fromEntries((change!.phases ?? []).map((p) => [p.id, p.state]));
    expect(byId.specs, "a delta spec exists, so the phase is done").toBe("done");
  } finally {
    __resetMethodsForTest();
    cleanup();
  }
});

test("FR-009 — archived content is READ-ONLY, and the refusal reaches every write seam", async () => {
  // `terminal` already stops the phase DAG being evaluated against archived
  // units. That is display. This is correctness: an archived change is the
  // record of what was decided, and other specs were merged from it — editing
  // it rewrites history with nothing to report the change.
  //
  // Before this, canEdit was store-level only (activeGroup?.writable && a live
  // branch), so an archived change was fully editable with no warning — the same
  // error US4 exists to prevent, one level down.
  const { cleanup } = useTestDataDir("openspec-readonly");
  try {
    __resetMethodsForTest();
    registerMethod(SPEC_KIT);
    registerMethod(OPENSPEC);
    await openspecStore();

    const archived = "user-specs/changes/archive/2026-01-01-add-login/proposal.md";
    let err: Error | undefined;
    await assertEditablePath(archived).catch((e: Error) => { err = e; });
    expect(err, "an archived artifact is refused").toBeDefined();
    expect(err!.message, "names the section and the method, so the user can act").toMatch(/archive/i);
    expect(err!.message).toContain("OpenSpec");

    // Active work in the SAME store is unaffected — the guard is per section,
    // not a store-wide read-only flag.
    await assertEditablePath("user-specs/changes/add-dark-mode/proposal.md");
    await assertEditablePath("user-specs/specs/auth/spec.md");

    // And the tree tells the client, so the UI can refuse before the user types.
    const group = (await specTree()).find((g) => g.name === "user-specs");
    const changes = (group?.children ?? []).find((n) => n.name === "changes");
    const archive = (changes?.children ?? []).find((n) => n.name === "archive");
    const unit = (archive?.children ?? [])[0];
    expect(unit?.terminal, "terminal reaches units INSIDE the section, not just its root").toBe(true);
    const live = (changes?.children ?? []).find((n) => n.name === "add-dark-mode");
    expect(live?.terminal, "active work is not frozen").toBeUndefined();
  } finally {
    __resetMethodsForTest();
    cleanup();
  }
});

test("FR-017 — `tasks` means PLANNED, `apply` means BUILT", async () => {
  // Upstream puts `apply` OUTSIDE its artifacts list: requires/tracks, no
  // generates. Collapsing it into `tasks` conflates writing the plan with doing
  // the work — a finished tasks.md with nothing ticked then reads as an artifact
  // still owed, and execution progress gets no chip at all.
  const { cleanup } = useTestDataDir("openspec-apply");
  try {
    __resetMethodsForTest();
    registerMethod(SPEC_KIT);
    registerMethod(OPENSPEC);
    const root = await openspecStore();

    const change = "changes/add-dark-mode";
    write(root, `${change}/specs/ui/spec.md`, "## ADDED Requirements\n");
    write(root, `${change}/design.md`, "# Design\n\nHow.\n");
    // A COMPLETE task list, none of it executed yet.
    write(root, `${change}/tasks.md`, "## 1. Work\n\n- [ ] 1.1 Do the thing\n- [ ] 1.2 Do the other\n");

    const phases = (await listSpecifications()).find((s) => s.path === `user-specs/${change}`)!.phases;
    const byId = Object.fromEntries(phases.map((p) => [p.id, p.state]));

    expect(byId.tasks, "the plan is written — the artifact is NOT owed").toBe("done");
    expect(byId.apply, "the work is not done").toBe("pending");

    // And once every box is ticked, apply — not tasks — is what flips.
    write(root, `${change}/tasks.md`, "## 1. Work\n\n- [x] 1.1 Do the thing\n- [x] 1.2 Do the other\n");
    const after = Object.fromEntries(
      (await listSpecifications()).find((s) => s.path === `user-specs/${change}`)!.phases.map((p) => [p.id, p.state]),
    );
    expect(after.apply).toBe("done");

    // `apply` generates no file, so it must not leak into the artifact list.
    const artifacts = (await listSpecifications()).find((s) => s.path === `user-specs/${change}`)!.artifacts.map((a) => a.name);
    expect(artifacts).not.toContain("apply");
  } finally {
    __resetMethodsForTest();
    cleanup();
  }
});
