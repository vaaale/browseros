// A mockup that is not beside its spec is not part of the feature.
//
// A real session produced a finished UI mockup and saved it to
// `/mockups/follow-the-money.html` in the VFS — the user's own sandbox. It does
// not ride the feature branch, does not promote or discard with the item, and
// nobody opening the item afterwards finds it.
//
// The instruction existed, but only in ONE place: the spec-kit pack's
// `ui-designer` agent prompt. That session was running BMAD, which ships no such
// agent, and the method-neutral craft skill deferred the whole file discipline to
// "the `ui-designer` agent's own prompt". So under any method without that agent,
// nothing said where the file goes — and an agent asked to produce an HTML file
// will put it somewhere.
//
// WHY GREP-SHAPED: the failure is a model reading instructions, which nothing at
// runtime can assert. What CAN be asserted is that no BOS-owned text tells an
// agent to build an HTML mockup without also saying where it belongs.
//
//   npm run test:unit -- tests/agent/ui-mockup-location.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";

/** BOS-owned instruction text that asks for an HTML mockup. */
function filesAskingForAnHtmlMockup(): string[] {
  return execFileSync("git", ["ls-files", "seed"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".md"))
    .filter((f) => /HTML mockup|self-contained HTML/i.test(readFileSync(f, "utf8")));
}

test("every instruction to build an HTML mockup also says where to save it", () => {
  const silent = filesAskingForAnHtmlMockup().filter((f) => !readFileSync(f, "utf8").includes("mockup.html"));
  expect(
    silent,
    "these tell an agent to produce an HTML mockup without naming the path — say `mockup.html` in the unit's own " +
      "spec directory (`item-<id>/mockup.html` via app_spec_write for a marketplace item)",
  ).toEqual([]);
});

test("the method-neutral skill carries the rule, not just one method's agent", () => {
  // The craft skill is loaded under EVERY method (`when_to_use`: "under any spec
  // framework"). spec-kit's ui-designer agent may keep the long-form workflow,
  // but the destination cannot live only there — that is exactly how BMAD ended
  // up with no rule at all.
  const skill = readFileSync("seed/skills/ui-designer-craft/SKILL.md", "utf8");
  expect(skill, "names the marketplace-item destination").toContain("item-<id>/mockup.html");
  expect(skill, "and the tool that can actually write there").toContain("app_spec_write");
  expect(skill, "and forbids the sandbox explicitly").toMatch(/\/mockups/);
});

test("the agent that actually runs the design carries the rule", () => {
  // The rule existed in ui-designer-craft and in bos-domain's reference — and
  // the mockup still went to `/workspace/<app>/mockup.html`, because Build
  // Studio was assigned NEITHER: its skills were `[bos-domain, intent]`, and a
  // reference file is only read on an explicit skill_read_file. Under a method
  // with no `ui-designer` agent (BMAD ships none — that agent belongs to the
  // spec-kit pack), Build Studio does the design itself, so the rule has to be
  // on its own always-loaded prompt and the craft skill has to be assigned.
  const agent = readFileSync("seed/agents/build-studio/AGENT.md", "utf8");
  expect(agent, "the craft skill must be assigned, or its rule is never loaded").toMatch(
    /^skills:.*ui-designer-craft/m,
  );
  expect(agent, "and the destination stated in the prompt itself").toContain("item-<id>/mockup.html");
  expect(agent, "including the trap that actually happened").toMatch(/staging directory/i);
});

test("the staging directory is named as the wrong place, not just the VFS", () => {
  // `/workspace/<app>/` was a legitimate STAGING directory — the app's code was
  // genuinely built there. "Not the VFS" did not cover it in the reader's mind,
  // so the reason has to be explicit: app_build carries facets, and a mockup is
  // not one.
  for (const f of ["seed/skills/ui-designer-craft/SKILL.md", "seed/skills/bos-domain/references/target-marketplace-item.md"]) {
    const text = readFileSync(f, "utf8");
    expect(text, `${f} must name the staging directory`).toMatch(/staging director/i);
    expect(text, `${f} must say why — app_build carries facets only`).toMatch(/facet/i);
  }
});

test("the marketplace-item reference says the mockup lives in the item", () => {
  // bos-domain is where "what physically lives inside an item, and which tool
  // reaches it" is stated for every method. A mockup is one of those things.
  const ref = readFileSync("seed/skills/bos-domain/references/target-marketplace-item.md", "utf8");
  expect(ref).toContain("item-<id>/mockup.html");
});
