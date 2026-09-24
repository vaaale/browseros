// 046 T001 — the relocation hand-off (FR-008b, SC-005a). THE GATE.
//
// 046 moves four agents and the driver skill out of `seed/` and into the
// spec-kit pack. On the first boot after that upgrade, a deployment still has
// `data/` copies of all of them, seeded from the OLD location. What happens to
// those copies is the entire risk of this feature, and the two kinds behave
// DIFFERENTLY:
//
//   agents — DISCOVERED from the pack root in place. `archiveDroppedSeedAgents`
//            moves the stale `data/agents/<id>` aside and 045's root precedence
//            then supplies the pack's copy. The archive firing IS the hand-off;
//            suppressing it would pin the stale copy forever, because
//            applySeedAgent never runs for an id absent from `seed/`.
//
//   skills — COPIED, through the bundled-asset provenance contract, by a
//            dedicated step. Not `.seed-rev`.
//
// This lands BEFORE any relocation: once assets move, the pre-relocation `data/`
// state cannot be reproduced from the tree to copy from.
//
// All three decideSeedAction branches are covered because deployments genuinely
// differ — this machine has 14 of 18 `data/agents/` stamped and 0 of 5
// `data/skills/`.
//   npm run test:unit -- tests/specs/relocation-handoff.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { useTestDataDir } from "../services/_test-env";
import { decideSeedAction, seedRev } from "../../src/lib/agent/seed-sync";
import { seedPackBundledSkills } from "../../src/system/marketplace/install/bundledAssets";
import { listPendingBundledAssetConflicts } from "../../src/system/marketplace/install/bundledAssets";

function writeSkill(root: string, id: string, body: string): string {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body);
  return dir;
}

// ---------------------------------------------------------------------------
// The three decideSeedAction branches, stated as the contract 046 relies on
// ---------------------------------------------------------------------------

test("stamped + unedited + dropped from seed ⇒ `archive` — the branch the hand-off needs", () => {
  // THE load-bearing branch. If this returns anything else, the stale data/
  // copy is never moved aside and the pack's version is permanently shadowed
  // by 045's root precedence (data/ wins over a pack root, by design).
  const body = "# build-studio\n";
  const rev = seedRev([body]);
  expect(decideSeedAction({ inSeed: false, liveRev: rev, stamp: { seed: "old-seed-rev", live: rev } })).toBe("archive");
});

test("UNSTAMPED ⇒ `local`, never `archive` — so no hand-off happens on its own", () => {
  // The `local` guard fires BEFORE the archive branch, so an unstamped copy is
  // spared. That is correct (it might be the deployment's own work) but it
  // means the relocation does NOT complete by itself on such a deployment —
  // the dedicated seeding step has to reach a destination that is still
  // present, and report a conflict rather than clobbering it.
  expect(decideSeedAction({ inSeed: false, liveRev: seedRev(["x"]), stamp: undefined })).toBe("local");
});

test("EDITED ⇒ `local` — the same terminal state as unstamped", () => {
  expect(
    decideSeedAction({ inSeed: false, liveRev: seedRev(["edited"]), stamp: { seed: "s", live: seedRev(["original"]) } }),
  ).toBe("local");
});

// ---------------------------------------------------------------------------
// The skill half: what the dedicated seeding step does in each state
// ---------------------------------------------------------------------------

test("archived (absent) destination ⇒ the pack's skill is COPIED in, with provenance", async () => {
  const { dir, cleanup } = useTestDataDir("handoff-skill-absent");
  try {
    const packPath = join(dir, "pack");
    writeSkill(join(packPath, "skills"), "build-studio", "# Pack driver skill\n");

    const r = await seedPackBundledSkills(packPath, "spec-kit", "1.0.0");

    expect(r.installed.map((a) => a.id), "an absent destination is a clean install").toEqual(["build-studio"]);
    expect(r.conflicts).toEqual([]);
    const dest = join(dir, "skills", "build-studio");
    expect(readFileSync(join(dest, "SKILL.md"), "utf8")).toBe("# Pack driver skill\n");
    // Provenance, not `.seed-rev` — a pack skill reconciles by the bundled-asset
    // contract. Recording the running tree's rev is FR-018.
    const prov = JSON.parse(readFileSync(join(dest, ".installed-from.json"), "utf8"));
    expect(prov.itemId).toBe("spec-kit");
    expect(prov.version).toBe("1.0.0");
  } finally {
    cleanup();
  }
});

test("a present, UNTRACKED destination ⇒ CONFLICT, not a clobber", async () => {
  // The unstamped/edited terminal state. There is a data/skills/build-studio
  // with no `.installed-from.json`, so its provenance is unknown — it may be
  // the deployment's own work, or skill_improve's rewrite. Overwriting it would
  // destroy that silently, which is exactly what bare copyAsset (rm -rf + cp,
  // no existence or provenance check) would do.
  const { dir, cleanup } = useTestDataDir("handoff-skill-untracked");
  try {
    const packPath = join(dir, "pack");
    writeSkill(join(packPath, "skills"), "build-studio", "# Pack driver skill\n");
    writeSkill(join(dir, "skills"), "build-studio", "# The deployment's own copy\n");

    const r = await seedPackBundledSkills(packPath, "spec-kit", "1.0.0");

    expect(r.installed, "nothing may be installed over an untracked copy").toEqual([]);
    expect(r.conflicts.map((c) => c.id)).toEqual(["build-studio"]);
    expect(readFileSync(join(dir, "skills", "build-studio", "SKILL.md"), "utf8"), "the local copy must survive untouched")
      .toBe("# The deployment's own copy\n");
    // …and the conflict is QUEUED for a keep-vs-replace decision rather than
    // logged and forgotten.
    expect((await listPendingBundledAssetConflicts()).map((c) => c.id)).toContain("build-studio");
  } finally {
    cleanup();
  }
});

test("a present, TRACKED, unmodified destination ⇒ replaced by the pack's newer copy", async () => {
  const { dir, cleanup } = useTestDataDir("handoff-skill-tracked");
  try {
    const packPath = join(dir, "pack");
    writeSkill(join(packPath, "skills"), "build-studio", "# v1\n");
    await seedPackBundledSkills(packPath, "spec-kit", "1.0.0");

    // The pack ships a new version; nobody touched the installed copy.
    writeFileSync(join(packPath, "skills", "build-studio", "SKILL.md"), "# v2\n");
    const r = await seedPackBundledSkills(packPath, "spec-kit", "2.0.0");

    expect(r.replaced.map((a) => a.id)).toEqual(["build-studio"]);
    expect(r.conflicts).toEqual([]);
    expect(readFileSync(join(dir, "skills", "build-studio", "SKILL.md"), "utf8")).toBe("# v2\n");
  } finally {
    cleanup();
  }
});

test("the pack's AGENTS are never copied into data/agents/ by the skill step", async () => {
  // 045 FR-001b: seed writes belong to data/agents/ and pack agents are
  // DISCOVERED in place. Reusing seedItemBundledAssets here would seed both
  // kinds and resurrect exactly the four copies T007 archives — the specific
  // reason this export is kind-scoped.
  const { dir, cleanup } = useTestDataDir("handoff-no-agents");
  try {
    const packPath = join(dir, "pack");
    writeSkill(join(packPath, "skills"), "build-studio", "# skill\n");
    mkdirSync(join(packPath, "agents", "architect"), { recursive: true });
    writeFileSync(join(packPath, "agents", "architect", "AGENT.md"), "---\nname: Architect\n---\nbody\n");

    await seedPackBundledSkills(packPath, "spec-kit", "1.0.0");

    expect(existsSync(join(dir, "agents", "architect")), "a pack agent must NOT be copied into data/agents/").toBe(false);
  } finally {
    cleanup();
  }
});

test("a pack with a SINGULAR `skill/` directory seeds nothing — the silent no-op guarded", async () => {
  // sourceRootFor pluralises the kind, and the readdir catches to [], so a
  // mis-named directory produces no error, no log and no skill. Pinned so the
  // pack layout cannot drift to the singular form unnoticed.
  const { dir, cleanup } = useTestDataDir("handoff-singular");
  try {
    const packPath = join(dir, "pack");
    writeSkill(join(packPath, "skill"), "build-studio", "# wrong directory name\n");

    const r = await seedPackBundledSkills(packPath, "spec-kit", "1.0.0");

    expect(r.installed, "singular `skill/` is not the source root").toEqual([]);
    expect(existsSync(join(dir, "skills", "build-studio"))).toBe(false);
  } finally {
    cleanup();
  }
});
