// 045 T001 — the parity gate for SC-001.
//
// 045 replaces `derivePhases`' hand-written if/else ladder (pipeline.ts:106-124)
// with a descriptor-driven rule evaluator. SC-001 requires the swap to be
// OBSERVATIONALLY IDENTICAL under spec-kit: same phases, same states, same
// order, same artifacts, same taskProgress. `label` is the only permitted
// addition, and there are NO permitted state substitutions.
//
// This baseline cannot be captured retroactively — once pipeline.ts is edited,
// "what it used to produce" is gone and SC-001 is unverifiable for the life of
// the feature (plan.md R1/R2). So this lands, green, BEFORE T003.
//
// WHY A BUILT CORPUS RATHER THAN A SNAPSHOT OF THE LIVE STORES: tasks.md
// describes snapshotting the real 132-feature corpus. A committed baseline of
// live data is green only on the machine that captured it — it depends on
// whatever specs, branches and installed items that deployment happens to have,
// which is precisely the pre-seeded-data dependency BOS's testing rule
// prohibits (docs/dev/testing.md). Instead the corpus below is BUILT, and is
// built to cover every branch of the ladder rather than whatever the live data
// happens to hit. The live corpus is still worth diffing once by hand during
// the refactor; it is not something to freeze into the suite.
//
//   npm run test:unit -- tests/specs/method-parity.test.ts
//
// Regenerate after an INTENTIONAL, reviewed change:
//   UPDATE_PARITY_BASELINE=1 npm run test:unit -- tests/specs/method-parity.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from "fs";
import { execFileSync } from "child_process";
import { useTestDataDir } from "../services/_test-env";
import { specsRoot } from "../../src/os/specs-dir";
import { ensureStores } from "../../src/lib/specs/seed";
import { listSpecifications } from "../../src/lib/specs/pipeline";
import type { Specification } from "../../src/lib/specs/types";

const BASELINE = join(__dirname, "_fixtures", "method-parity-baseline.json");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function write(root: string, rel: string, body: string): void {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
}

/** A tasks.md with `total` checklist items, `done` of them ticked. */
function tasksBody(total: number, done: number): string {
  const lines = ["# Tasks", ""];
  for (let i = 1; i <= total; i++) {
    lines.push(`- [${i <= done ? "x" : " "}] T${String(i).padStart(3, "0")} task ${i}`);
  }
  return lines.join("\n") + "\n";
}

/** Every distinct path through derivePhases (pipeline.ts:106-124).
 *
 *  Discovery requires spec.md (walkFeatureLeaves:202), so within a
 *  directory-scanned store `specify` is always `done` and `clarify`'s `na`
 *  branch is unreachable. Both are reachable in an ITEM store, which is built
 *  unconditionally (buildItemSpecification:165) — covered separately below.
 *  That asymmetry is exactly the kind of thing a descriptor refactor can
 *  quietly flatten, which is why both shapes are in the corpus. */
const FEATURES: Array<{ id: string; files: Record<string, string>; note: string }> = [
  { id: "001-spec-only", note: "clarify pending, plan pending, tasks/implement/test/converge na", files: { "spec.md": "# Spec only\n" } },
  { id: "002-clarified", note: "clarify done via the ## Clarifications heading", files: { "spec.md": "# Clarified\n\n## Clarifications\n\nQ/A\n" } },
  { id: "003-planned", note: "plan done -> tasks pending", files: { "spec.md": "# Planned\n", "plan.md": "# Plan\n" } },
  // tasks.md present but with ZERO parseable `- [ ]` items: pipeline.ts:108-109
  // leaves implement `na`. A checklist predicate without a `total > 0` guard
  // reports vacuously-true "all done" and flips this to `done` (tasks.md T004).
  // 9 live features have a tasks.md in exactly this shape.
  { id: "004-tasks-unparseable", note: "tasks done, implement na — the total>0 guard", files: { "spec.md": "# T\n", "plan.md": "# P\n", "tasks.md": "# Tasks\n\nProse only, no checklist items.\n" } },
  { id: "005-tasks-none-done", note: "implement na — done === 0 is na, not pending", files: { "spec.md": "# T\n", "plan.md": "# P\n", "tasks.md": tasksBody(4, 0) } },
  { id: "006-tasks-partial", note: "implement pending", files: { "spec.md": "# T\n", "plan.md": "# P\n", "tasks.md": tasksBody(4, 2) } },
  { id: "007-tasks-all-done", note: "implement done", files: { "spec.md": "# T\n", "plan.md": "# P\n", "tasks.md": tasksBody(4, 4) } },
  // test keys on CONTENT, not on the file listing (pipeline.ts:111-113 reads
  // then tests truthiness). An empty test-results.md is `na`, so the predicate
  // is `nonEmpty`, not `exists` (tasks.md T004).
  { id: "008-test-empty", note: "test na — empty file, nonEmpty not exists", files: { "spec.md": "# T\n", "test-results.md": "" } },
  { id: "009-test-failed", note: "test pending — present, not PASSED", files: { "spec.md": "# T\n", "test-results.md": "# Results\n\n**Status**: FAILED\n" } },
  { id: "010-test-passed", note: "test done", files: { "spec.md": "# T\n", "test-results.md": "# Results\n\n**Status**: PASSED\n" } },
  // byArtifactOrder's tail: design.md and test-results.md are absent from
  // ARTIFACT_FILES, so both fall to 99 and then localeCompare. 23 live
  // features carry a design.md; re-ranking it changes Specification.artifacts[],
  // which SC-001 requires be identical (tasks.md T006).
  { id: "011-artifact-order", note: "the 99 -> localeCompare tail", files: { "spec.md": "# T\n", "plan.md": "# P\n", "tasks.md": tasksBody(2, 1), "research.md": "# R\n", "data-model.md": "# D\n", "quickstart.md": "# Q\n", "design.md": "# Design\n", "test-results.md": "# Results\n\n**Status**: PASSED\n", "zzz-extra.md": "# Z\n" } },
  { id: "012-converge", note: "converge done — id appears in discrepancies.md", files: { "spec.md": "# T\n" } },
];

/** Builds the corpus and returns the normalized snapshot. */
async function buildAndSnapshot(dataDir: string): Promise<unknown> {
  await ensureStores();
  const root = specsRoot();
  const userSpecs = join(root, "user-specs");

  // A READY constitution in the SYSTEM store (hasConstitution:72-79 reads it
  // through systemStoreId() for every store, including item stores). This is
  // load-bearing for the baseline, not set dressing: `constitutionRoot`
  // (FR-006b) exists only to preserve that cross-store read, and with no
  // constitution anywhere every feature sits at `pending` — so a T008
  // regression that scoped resolution per-store would flip nothing and the
  // baseline would stay green through exactly the break it is meant to catch.
  // "Ready" = present and not the [TOKENS] placeholder (pipeline.ts:77).
  write(join(root, "bos-system-specs"), ".specify/memory/constitution.md", "# BrowserOS Constitution\n\n## I. Spec-Driven\n\nEvery feature starts as a spec.\n");
  git(join(root, "bos-system-specs"), ["add", "-A"]);
  git(join(root, "bos-system-specs"), ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "constitution"]);

  // A Project is mandatory for a directory-scanned store (037).
  write(userSpecs, "parity/project.json", JSON.stringify({ label: "Parity", description: "045 T001 corpus" }, null, 2));
  for (const f of FEATURES) {
    for (const [name, body] of Object.entries(f.files)) write(userSpecs, `parity/${f.id}/${name}`, body);
  }
  // converge reads BOTH the system store's frozen copy and user-specs'
  // (pipeline.ts:100-104). 012's id must appear for it to resolve `done`.
  write(userSpecs, "discrepancies.md", "- user-specs/parity/012-converge: drift found\n");

  // A feature nested below a plain sub-folder — the leaf rule is "directly
  // contains spec.md" at ANY depth, not a fixed depth (pipeline.ts:195-208).
  write(userSpecs, "parity/nested/013-deep/spec.md", "# Deep\n");
  // A directory that is NOT a leaf (no spec.md) must not become a feature.
  write(userSpecs, "parity/nested/notes.md", "# not a feature\n");

  git(userSpecs, ["add", "-A"]);
  git(userSpecs, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "parity corpus"]);

  // A live draft `bos/*` branch (020). Its feature exists ONLY on the branch,
  // which is the overlay path listSpecifications:333-339 covers and the case a
  // user is most likely to be actively looking at.
  const base = git(userSpecs, ["rev-parse", "--abbrev-ref", "HEAD"]);
  git(userSpecs, ["checkout", "-q", "-b", "bos/testfixture-parity-draft"]);
  write(userSpecs, "parity/014-draft-only/spec.md", "# Draft only\n\n## Clarifications\n\nQ/A\n");
  write(userSpecs, "parity/014-draft-only/tasks.md", tasksBody(3, 3));
  git(userSpecs, ["add", "-A"]);
  git(userSpecs, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "draft feature"]);
  git(userSpecs, ["checkout", "-q", base]);

  // Item-owned stores (item-stores.ts): built unconditionally, so unlike a
  // directory-scanned feature an item WITHOUT spec.md is reachable — the only
  // way `specify: pending` and `clarify: na` appear at all. constitutionRoot
  // (FR-006b) exists because per-store constitution resolution would flip
  // these `done -> pending`; a corpus without them cannot see that regression.
  const items = join(dataDir, "user-apps", "items");
  const systemDir = join(dataDir, "system");
  mkdirSync(systemDir, { recursive: true });
  for (const [id, files] of Object.entries<Record<string, string>>({
    "item-with-spec": { "spec.md": "# Item spec\n", "plan.md": "# Plan\n" },
    "item-without-spec": { "notes.md": "# no spec.md here\n" },
  })) {
    for (const [name, body] of Object.entries(files)) write(items, `${id}/spec/${name}`, body);
    symlinkSync(join(items, id), join(systemDir, id));
  }
  git(join(dataDir, "user-apps"), ["init", "-q"]);
  git(join(dataDir, "user-apps"), ["add", "-A"]);
  git(join(dataDir, "user-apps"), ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "items"]);

  return normalize(await listSpecifications());
}

/** Every field SC-001 pins, in a stable shape. `label` is deliberately NOT
 *  read here: it is the one permitted addition, so its arrival must not move
 *  the baseline. Everything else is compared exactly. */
function normalize(specs: Specification[]): unknown {
  return specs
    .map((s) => ({
      id: s.id,
      store: s.store,
      title: s.title,
      path: s.path,
      branch: s.branch ?? null,
      artifacts: s.artifacts.map((a) => ({ name: a.name, path: a.path })),
      taskProgress: s.taskProgress ?? null,
      phases: s.phases.map((p) => ({ id: p.id, state: p.state })),
    }))
    .sort((a, b) => `${a.path}|${a.branch}`.localeCompare(`${b.path}|${b.branch}`));
}

test("spec-kit phase/artifact output is unchanged by the method layer (SC-001)", async () => {
  const { dir, cleanup } = useTestDataDir("method-parity");
  try {
    const actual = await buildAndSnapshot(dir);

    if (process.env.UPDATE_PARITY_BASELINE === "1") {
      mkdirSync(join(BASELINE, ".."), { recursive: true });
      writeFileSync(BASELINE, JSON.stringify(actual, null, 2) + "\n");
      test.info().annotations.push({ type: "baseline", description: `rewrote ${BASELINE}` });
      return;
    }

    expect(
      existsSync(BASELINE),
      `no parity baseline at ${BASELINE} — capture it BEFORE editing pipeline.ts:\n  UPDATE_PARITY_BASELINE=1 npm run test:unit -- tests/specs/method-parity.test.ts`,
    ).toBe(true);

    const expected = JSON.parse(readFileSync(BASELINE, "utf8"));
    // Deep equality over the whole corpus at once: a per-feature loop reports
    // the first mismatch and hides the blast radius, and "how many features
    // moved" is the number that says whether a change is a typo or a
    // semantic regression.
    expect(actual).toEqual(expected);
  } finally {
    cleanup();
  }
});

test("no phase resolves to `blocked` under spec-kit (SC-001, tasks.md ordering rule 2)", async () => {
  // spec-kit declares `requires: []` on all nine phases (T006) — gating lives
  // in the clauses, not the edges — so `blocked` is UNREACHABLE under it. Its
  // appearance means an edge was introduced that design.md §3.4 forbids, and
  // under the linear edges PHASE_ORDER suggests that is not a cosmetic slip:
  // `converge requires implement` flips 120 of 132 live features `na ->
  // blocked` and `test requires implement` flips 114.
  //
  // This is a SEPARATE assertion from the baseline rather than a property of
  // it: a regenerated baseline would happily absorb `blocked` everywhere and
  // still pass, which is exactly the failure this rule exists to stop.
  const { dir, cleanup } = useTestDataDir("method-parity-blocked");
  try {
    await buildAndSnapshot(dir);
    const offenders = (await listSpecifications())
      .flatMap((s) => s.phases.map((p) => ({ path: s.path, ...p })))
      .filter((p) => (p.state as string) === "blocked");
    expect(offenders, `phases resolved to \`blocked\`:\n${offenders.map((o) => `  ${o.path} → ${o.id}`).join("\n")}`).toEqual([]);
  } finally {
    cleanup();
  }
});

test("an unfilled constitution template resolves `pending`, not `done`", async () => {
  // hasConstitution:77 is present-AND-not-placeholder, not mere existence. The
  // main corpus cannot cover this branch: the constitution is resolved once
  // per request for ALL stores, so one corpus can only ever witness one value.
  // Cover it separately rather than leaving half of FR-006b's behaviour
  // unpinned — the descriptor makes this path configurable, which is exactly
  // when a two-condition check tends to decay into an `exists` check.
  const { dir, cleanup } = useTestDataDir("method-parity-constitution");
  try {
    await buildAndSnapshot(dir);
    const ready = (await listSpecifications()).every((s) => s.phases.find((p) => p.id === "constitution")?.state === "done");
    expect(ready, "corpus precondition: a filled constitution should read `done` everywhere").toBe(true);

    write(join(specsRoot(), "bos-system-specs"), ".specify/memory/constitution.md", "# [PROJECT_NAME] Constitution\n\nUnfilled template.\n");
    const states = new Set((await listSpecifications()).map((s) => s.phases.find((p) => p.id === "constitution")?.state));
    expect([...states], "a placeholder constitution must read `pending` for every store").toEqual(["pending"]);
  } finally {
    cleanup();
  }
});

test("the corpus actually exercises every phase state (guards the guard)", async () => {
  // A parity baseline over a corpus that only ever produces `done` would pass
  // through any refactor. Pin the coverage itself: if a future edit narrows
  // the corpus, this fails rather than the parity test silently weakening.
  const { dir, cleanup } = useTestDataDir("method-parity-coverage");
  try {
    await buildAndSnapshot(dir);
    const specs = await listSpecifications();
    const seen = new Set(specs.flatMap((s) => s.phases.map((p) => `${p.id}:${p.state}`)));

    for (const required of [
      "specify:done", "specify:pending",   // pending only reachable via an item store
      "clarify:done", "clarify:pending", "clarify:na",
      "plan:done", "plan:pending",
      "tasks:done", "tasks:pending", "tasks:na",
      "implement:done", "implement:pending", "implement:na",
      "test:done", "test:pending", "test:na",
      "converge:done", "converge:na",
      // `done` specifically: it is what proves the cross-store constitution
      // read still resolves for EVERY store, item stores included (FR-006b).
      "constitution:done",
      "analyze:na",
    ]) {
      expect(seen.has(required), `corpus never produces ${required} — parity coverage has a hole`).toBe(true);
    }
    // The draft-branch overlay must be represented, or the baseline says
    // nothing about listSpecifications:333-339.
    expect(specs.some((s) => s.branch), "corpus has no draft-branch specification").toBe(true);
  } finally {
    cleanup();
  }
});
