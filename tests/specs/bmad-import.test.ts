// 048 T022 / SC-017 — the pack carries what upstream publishes.
//
// THE TEST THAT WOULD HAVE CAUGHT SHIPPING 4 OF 30. The 048 plan asserted
// mechanism thoroughly — provider roots resolve, the overlay survives an
// upgrade, precedence is one rule — and every one of those passed while the pack
// contained a seventh of the method it claimed to package. Nothing asserted
// COVERAGE, so "we shipped a fraction of BMAD" was not a failing test; it was
// not a test at all.
//
// Counted against `method/upstream.json`, which the importer writes from the
// published package, so the number is upstream's rather than one somebody typed.
//
//   npm run test:unit -- tests/specs/bmad-import.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

const PACK = join(process.cwd(), "data/user-apps/items/bmad/method");
const upstreamFile = join(PACK, "upstream.json");

interface Upstream {
  package: string;
  version: string;
  skills: string[];
  modules?: Record<string, { npm: string; version: string; skills: string[]; notRendered: string[] }>;
}

function upstream(): Upstream | null {
  if (!existsSync(upstreamFile)) return null;
  return JSON.parse(readFileSync(upstreamFile, "utf8")) as Upstream;
}

test("every skill upstream publishes is present in the pack", () => {
  const u = upstream();
  test.skip(u === null, "BMAD is not installed — clone the marketplace to exercise this");

  const present = new Set(readdirSync(join(PACK, "skills")));
  const missing = u!.skills.filter((s) => !present.has(s));
  expect(missing, `imported from ${u!.package}@${u!.version}; re-run tools/import-upstream.mjs`).toEqual([]);
  expect(u!.skills.length, "30 from bmad-method + 2 from bmad-builder").toBeGreaterThanOrEqual(32);
});

test("the imported skills carry their ASSETS, which is where BMAD keeps templates", () => {
  // The pack previously declared a pack-level `templates` directory that never
  // existed, and told five phases to author against it. BMAD's templates were
  // always per-skill, under assets/.
  const u = upstream();
  test.skip(u === null, "BMAD is not installed");

  for (const [skill, asset] of [
    ["bmad-prd", "assets/prd-template.md"],
    ["bmad-product-brief", "assets/brief-template.md"],
    ["bmad-spec", "assets/spec-template.md"],
    ["bmad-architecture", "assets/spine-template.md"],
  ]) {
    expect(existsSync(join(PACK, "skills", skill, asset)), `${skill}/${asset}`).toBe(true);
  }
});

test("the customisation surface came with them", () => {
  // 27 of upstream's 30 ship a customize.toml. BOS must not implement a second
  // merge over it (FR-004) — but it must not lose it either.
  const u = upstream();
  test.skip(u === null, "BMAD is not installed");
  const withCustomize = u!.skills.filter((s) => existsSync(join(PACK, "skills", s, "customize.toml")));
  expect(withCustomize.length).toBeGreaterThanOrEqual(27);
});

test("the Python runtime is carried, and declared as a project runtime", () => {
  const u = upstream();
  test.skip(u === null, "BMAD is not installed");

  for (const f of ["memlog.py", "render_skill.py", "resolve_config.py", "resolve_customization.py", "config_utils.py"]) {
    expect(existsSync(join(PACK, "runtime/scripts", f)), f).toBe(true);
  }
  const d = JSON.parse(readFileSync(join(PACK, "method.json"), "utf8")) as {
    projectRuntime?: { dir: string; from: string; preserve?: string[] };
    templates?: string;
  };
  expect(d.projectRuntime, "declared, or BOS writes into no repository for it").toEqual({
    dir: "_bmad",
    from: "runtime",
    preserve: ["custom"],
  });
  expect(d.templates, "BMAD has no pack-level templates dir; its templates are per-skill").toBeUndefined();
});

test("upstream's own compatibility shims and test suites are NOT vendored", () => {
  // v6-shims alias pre-v6 skill names for upstream's migrating users; BOS has
  // none. tests/ is upstream's pytest CI. __pycache__ is build output that the
  // published tarball happens to carry.
  const u = upstream();
  test.skip(u === null, "BMAD is not installed");
  // Named explicitly rather than matched by prefix: `bmad-create-epics-and-stories`
  // is a REAL plan skill and a `bmad-create-*` filter would have banned it.
  const shims = ["bmad-create-prd", "bmad-edit-prd", "bmad-validate-prd", "bmad-create-architecture",
    "bmad-create-story", "bmad-dev-story", "bmad-dev-auto", "bmad-quick-dev", "bmad-document-project",
    "bmad-market-research", "bmad-technical-research", "bmad-domain-research", "bmad-sprint-status",
    "bmad-checkpoint-preview", "bmad-editorial-review"];
  expect(u!.skills.filter((s) => shims.includes(s)), "upstream's own migration aliases").toEqual([]);
  expect(u!.skills, "but the real plan skill with a similar name IS here").toContain("bmad-create-epics-and-stories");
  expect(existsSync(join(PACK, "skills", "bmad-prd", "__pycache__"))).toBe(false);
  expect(existsSync(join(PACK, "skills", "bmad-brainstorming", "scripts", "tests"))).toBe(false);
});

test("a re-import cannot clobber the pack's own BOS skills", () => {
  // FR-027. These three hold the BOS-specific knowledge that could not be
  // imported — real containers, the window model, BOS's story shapes — and they
  // are safe for a structural reason rather than a careful one: they have
  // DIFFERENT IDS from upstream's, and the importer writes only upstream's.
  const u = upstream();
  test.skip(u === null, "BMAD is not installed");

  for (const ours of ["bmad-bos-architecture", "bmad-bos-ux", "bmad-bos-stories", "bmad-driver"]) {
    expect(existsSync(join(PACK, "skills", ours)), ours).toBe(true);
    expect(u!.skills, `${ours} is OURS — the importer must never own it`).not.toContain(ours);
  }
  // And the upstream counterparts they complement are present alongside, so a
  // user can reach the generic version too.
  for (const theirs of ["bmad-architecture", "bmad-ux", "bmad-create-epics-and-stories"]) {
    expect(existsSync(join(PACK, "skills", theirs)), theirs).toBe(true);
  }
});

test("BMB is imported; CIS ships manifests and is REPORTED rather than faked", () => {
  // bmb and cis are separate npm packages, not part of bmad-method. The pack
  // used to DECLARE both while shipping neither — the picker offered two modules
  // that contributed nothing.
  //
  // They are not in the same shape, and the importer says so:
  //   bmad-builder ships real SKILL.md files -> imported.
  //   cis ships `bmad-skill-manifest.yaml` ONLY — persona metadata that BMAD's
  //     own installer renders into a SKILL.md. Copying those would put YAML
  //     where BOS expects a skill and register nothing, so they are skipped BY
  //     NAME. Rendering them means running upstream's renderer, not
  //     reimplementing it.
  const u = upstream();
  test.skip(u === null || !u.modules, "modules were not imported");

  expect(u!.modules!.bmb.skills, "BMB's two builders").toEqual(["bmad-agent-builder", "bmad-workflow-builder"]);
  expect(u!.modules!.bmb.notRendered, "all of BMB is real content").toEqual([]);
  for (const s of u!.modules!.bmb.skills) {
    expect(existsSync(join(PACK, "skills", s)), s).toBe(true);
  }

  expect(u!.modules!.cis.skills, "nothing importable").toEqual([]);
  expect(u!.modules!.cis.notRendered.length, "and all ten named, not silently absent").toBe(10);
  expect(existsSync(join(PACK, "skills", "bmad-cis-agent-storyteller")), "no YAML masquerading as a skill").toBe(false);
});

test("no module is DECLARED that the pack cannot back with agents", () => {
  // The bug this pack shipped twice: declaring bmb/cis with agentsDir paths that
  // never existed. BMB contributes SKILLS and no agents, so it needs no module
  // declaration at all — `modules[]` gates AGENT roots.
  const d = JSON.parse(readFileSync(join(PACK, "method.json"), "utf8")) as {
    modules?: Array<{ id: string; agentsDir?: string }>;
  };
  for (const m of d.modules ?? []) {
    const dir = m.agentsDir ?? `modules/${m.id}/agents`;
    expect(existsSync(join(PACK, dir)), `module "${m.id}" declares ${dir}`).toBe(true);
  }
});

test("every phase names the skill that performs it, and the skill is installed", () => {
  // 048 FR-028. The mapping existed only as a prose table inside
  // bmad-driver/SKILL.md — readable by an agent, invisible to every surface. So
  // the inspector reported "declares no prompts" for all ten phases while
  // bmad-prd alone carried a 14k prompt, four assets, two references and an 8k
  // customisation schema.
  const u = upstream();
  test.skip(u === null, "BMAD is not installed");

  const d = JSON.parse(readFileSync(join(PACK, "method.json"), "utf8")) as {
    phases: Array<{ id: string; skills?: string[] }>;
  };
  const undescribed = d.phases.filter((p) => !p.skills?.length).map((p) => p.id);
  expect(undescribed, "a phase BOS can say nothing about").toEqual([]);

  // And every named skill exists — a phase pointing at a skill nobody ships is
  // the declared-but-absent defect this pack produced three times already.
  for (const p of d.phases) {
    for (const s of p.skills ?? []) {
      expect(existsSync(join(PACK, "skills", s)), `phase "${p.id}" names skill "${s}"`).toBe(true);
    }
  }
});

test("a phase's skill answers what/how/how-to-change", async () => {
  const u = upstream();
  test.skip(u === null, "BMAD is not installed");
  const { readPhaseSkills } = await import("../../src/lib/specs/method/phase-skill");
  const { ensureBuiltinMethod } = await import("../../src/lib/specs/method/resolve");
  const { registerMethod } = await import("../../src/lib/specs/method/registry");
  ensureBuiltinMethod();
  registerMethod(JSON.parse(readFileSync(join(PACK, "method.json"), "utf8")), PACK);

  // Read from the pack root here rather than data/skills, so the assertion does
  // not depend on this machine having seeded them.
  const skills = await readPhaseSkills("bmad", "prd", PACK);
  expect(skills.map((s) => s.id)).toEqual(["bmad-prd"]);
  const prd = skills[0];
  expect(prd.missing).toBe(false);
  expect(prd.description, "WHAT it does").toContain("PRD");
  expect(prd.body.length, "HOW it does it").toBeGreaterThan(1000);
  expect(prd.assets, "what it works from").toContain("prd-template.md");
  expect(prd.references).toContain("validate.md");
  expect(prd.customize, "HOW TO CHANGE IT — the pack's own surface").not.toBeNull();
  expect(prd.customize!.rel).toBe("customize.toml");
});
