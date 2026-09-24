// 048 T019 / FR-024 — a skill directory is carried AS IT IS.
//
// BOS's skill model knew two subdirectories, `scripts/` and `references/`.
// BMAD's 30 skills use six more plus loose root files, and the templates that
// make half those skills work live in `assets/`. Seeding through an allowlist
// would have carried nothing it had not been taught, silently — the same
// allowlist failure this codebase produced twice in one day (a store manifest
// dropping `workflow`, and a pack declaring a templates dir nobody checked).
//
//   npm run test:unit -- tests/agent/skill-files.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { useTestDataDir } from "../services/_test-env";

function write(root: string, rel: string, body: string): void {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
}

/** A skill laid out the way BMAD actually lays one out. */
function bmadShapedSkill(dir: string): void {
  write(dir, "SKILL.md", "---\nname: bmad-prd\ndescription: Create a PRD\n---\n\n# BMad PRD\n");
  write(dir, "customize.toml", '[workflow]\npersistent_facts = []\n');
  write(dir, "assets/prd-template.md", "# PRD Template\n");
  write(dir, "assets/prd-validation-checklist.md", "- [ ] testable\n");
  write(dir, "assets/validation-report-template.html", "<html></html>\n");
  write(dir, "references/validate.md", "How to validate.\n");
  write(dir, "references/headless.md", "Headless mode.\n");
  write(dir, "scripts/helper.py", "print('hi')\n");
  // The five shapes an allowlist would have dropped:
  write(dir, "steps/step-01-clarify.md", "Clarify.\n");
  write(dir, "review-prompts/lens-a.md", "Lens A.\n");
  write(dir, "templates/inner.md", "Inner.\n");
  write(dir, "agents/sub.md", "Sub-agent body.\n");
  write(dir, "workflow.md", "The workflow.\n");
  // Build output, which must NOT be carried.
  write(dir, "scripts/__pycache__/helper.cpython-313.pyc", "\x00binary\n");
  write(dir, "__pycache__/stale.pyc", "\x00binary\n");
  write(dir, ".hidden", "no\n");
}

test("a BMAD-shaped skill survives seeding with every file intact", async () => {
  const { dir, cleanup } = useTestDataDir("skill-files-roundtrip");
  try {
    const src = join(dir, "pack", "skills", "bmad-prd");
    bmadShapedSkill(src);

    // The REAL pack install path, not a hand-copy — FR-016's rule.
    const { seedPackBundledSkills } = await import("../../src/system/marketplace/install/bundledAssets");
    const r = await seedPackBundledSkills(join(dir, "pack"), "bmad", "6.12.0");
    expect(r.failures, "seeding reported no failure").toEqual([]);

    const live = join(dir, "skills", "bmad-prd");
    expect(existsSync(live), "the skill seeded").toBe(true);

    // The templates — the whole point of FR-024.
    expect(readFileSync(join(live, "assets/prd-template.md"), "utf8")).toBe("# PRD Template\n");
    expect(existsSync(join(live, "assets/validation-report-template.html"))).toBe(true);
    // The customization surface, a ROOT file rather than a directory.
    expect(readFileSync(join(live, "customize.toml"), "utf8")).toContain("[workflow]");
    // The four layouts an allowlist would have silently dropped.
    for (const rel of ["steps/step-01-clarify.md", "review-prompts/lens-a.md", "templates/inner.md", "agents/sub.md", "workflow.md"]) {
      expect(existsSync(join(live, rel)), `${rel} must be carried`).toBe(true);
    }
    // What BOS already carried, unchanged.
    expect(existsSync(join(live, "references/validate.md"))).toBe(true);
    expect(existsSync(join(live, "scripts/helper.py"))).toBe(true);

    // Install is a FAITHFUL copy — copyAsset does `fs.cp(..., {recursive: true})`
    // and is not in the business of deciding what a pack meant to ship. So the
    // byte-cache lands on disk, and it is the MODEL that must not call it
    // content. (Stripping it belongs to the import step, 048 T022 — BMAD's own
    // published tarball carries __pycache__ directories.)
    expect(existsSync(join(live, "__pycache__")), "copied verbatim, by design").toBe(true);

    const { getSkill } = await import("../../src/lib/agent/skills/store");
    const skill = await getSkill("bmad-prd");
    expect(
      skill?.files?.map((f) => f.name).filter((n) => n.includes("__pycache__")),
      "build output is not content",
    ).toEqual([]);
    expect(skill?.files?.map((f) => f.name).sort(), "reported by RELATIVE PATH").toEqual([
      "agents/sub.md",
      "assets/prd-template.md",
      "assets/prd-validation-checklist.md",
      "assets/validation-report-template.html",
      "customize.toml",
      "review-prompts/lens-a.md",
      "steps/step-01-clarify.md",
      "templates/inner.md",
      "workflow.md",
    ]);
    expect(skill?.scripts?.map((s) => s.name), "scripts stay their own field").toEqual(["helper.py"]);
  } finally {
    cleanup();
  }
});

test("the OBJECT MODEL reports every file, not just scripts and references", async () => {
  // What actually changed. Installing already copied the whole directory
  // (copyAsset does a recursive fs.cp), and listSkillFiles already walked it —
  // so an agent could always read a template. But getSkill() described a skill
  // as SKILL.md + scripts + references, so anything reasoning about its contents
  // saw a partial answer, and the change-hash could not see a template edit.
  const { dir, cleanup } = useTestDataDir("skill-files-model");
  try {
    bmadShapedSkill(join(dir, "pack", "skills", "bmad-prd"));
    const { seedPackBundledSkills } = await import("../../src/system/marketplace/install/bundledAssets");
    await seedPackBundledSkills(join(dir, "pack"), "bmad", "6.12.0");

    const { getSkill, listSkillFiles } = await import("../../src/lib/agent/skills/store");
    const skill = await getSkill("bmad-prd");
    expect(skill?.files?.map((f) => f.name).sort(), "reported by RELATIVE PATH").toEqual([
      "agents/sub.md",
      "assets/prd-template.md",
      "assets/prd-validation-checklist.md",
      "assets/validation-report-template.html",
      "customize.toml",
      "review-prompts/lens-a.md",
      "steps/step-01-clarify.md",
      "templates/inner.md",
      "workflow.md",
    ]);
    expect(skill?.scripts?.map((s2) => s2.name), "scripts stay their own field").toEqual(["helper.py"]);
    expect(skill?.references?.map((r) => r.name)).toEqual(["headless.md", "validate.md"]);

    // The agent-facing walk was always complete; this pins that the two agree.
    const walked = (await listSkillFiles("bmad-prd")).filter((f) => !f.includes("__pycache__"));
    const modelled = [
      ...(skill?.files ?? []).map((f) => f.name),
      ...(skill?.scripts ?? []).map((f) => `scripts/${f.name}`),
      ...(skill?.references ?? []).map((f) => `references/${f.name}`),
    ];
    expect(modelled.sort(), "the model and the walk describe the same skill").toEqual(walked.sort());
  } finally {
    cleanup();
  }
});

test("editing a TEMPLATE counts as a change, so the skill re-seeds", async () => {
  // The hash covered SKILL.md + scripts + references. A pack whose only change
  // is a template would have looked current and never refreshed — the skill on
  // disk silently a version behind.
  const { dir, cleanup } = useTestDataDir("skill-files-rev");
  try {
    const src = join(dir, "pack", "skills", "bmad-prd");
    bmadShapedSkill(src);
    const { seedPackBundledSkills } = await import("../../src/system/marketplace/install/bundledAssets");
    await seedPackBundledSkills(join(dir, "pack"), "bmad", "6.12.0");

    const live = join(dir, "skills", "bmad-prd", "assets", "prd-template.md");
    expect(readFileSync(live, "utf8")).toBe("# PRD Template\n");

    // An upgrade whose ONLY change is a template must still land.
    write(src, "assets/prd-template.md", "# PRD Template v2\n");
    await seedPackBundledSkills(join(dir, "pack"), "bmad", "6.13.0");
    expect(readFileSync(live, "utf8"), "the edit reached the live copy").toBe("# PRD Template v2\n");
  } finally {
    cleanup();
  }
});

test("a skill with no extra files is unchanged — the change is additive", async () => {
  const { dir, cleanup } = useTestDataDir("skill-files-additive");
  try {
    const src = join(dir, "pack", "skills", "plain");
    write(src, "SKILL.md", "---\nname: plain\ndescription: Plain\n---\n\nBody.\n");
    write(src, "references/one.md", "One.\n");

    const { seedPackBundledSkills } = await import("../../src/system/marketplace/install/bundledAssets");
    await seedPackBundledSkills(join(dir, "pack"), "p", "1");
    const { getSkill } = await import("../../src/lib/agent/skills/store");

    const skill = await getSkill("plain");
    expect(skill?.references?.map((r) => r.name)).toEqual(["one.md"]);
    expect(skill?.files, "nothing extra, and nothing invented").toEqual([]);
  } finally {
    cleanup();
  }
});
