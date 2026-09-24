import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import {
  hasSourceCitation,
  isOwnership,
  isScopeClass,
  parseDiagnosticsReport,
  parseFrontmatterBlock,
  renderDiagnosticsReport,
  reportPathFor,
} from "../../src/lib/self-heal/report";

// 031-self-healing FR-007/FR-028. This parser stands between an LLM's output
// and a pipeline that modifies source, so it validates rather than coerces: an
// almost-right report is REJECTED with the specific reason, because a missing
// proposedSurface would send a developer nowhere and an invented scopeClass
// would send one to the wrong fix surface entirely.

const VALID = `---
caseId: "0001"
scopeClass: e
ownership: bos-core
proposedSurface: "src/lib/assistant/tools/frontend-declarations.ts + FrontendToolsV2.tsx"
triggeredAt: 2026-09-07T10:00:00.000Z
verdict: "genuine gap: bos_app_launch drops params"
---

## Investigation

\`src/store/os-store.ts:11\` shows launch(appId, params?) has always accepted params.
`;

test.describe("parseFrontmatterBlock", () => {
  test("splits a fenced block into flat fields and a body", () => {
    const { fields, body } = parseFrontmatterBlock(VALID);
    expect(fields.scopeClass).toBe("e");
    expect(fields.ownership).toBe("bos-core");
    expect(fields.caseId).toBe("0001"); // quotes stripped
    expect(fields.proposedSurface).toContain("frontend-declarations.ts");
    expect(body.startsWith("## Investigation")).toBe(true);
  });

  test("a document with no frontmatter yields no fields and the whole text as the body", () => {
    const { fields, body } = parseFrontmatterBlock("just some prose");
    expect(fields).toEqual({});
    expect(body).toBe("just some prose");
  });

  test("comment and blank lines inside the block are ignored", () => {
    const { fields } = parseFrontmatterBlock("---\n# a comment\n\nscopeClass: a\n---\nbody");
    expect(fields).toEqual({ scopeClass: "a" });
  });

  test("a line with no colon is skipped rather than corrupting the map", () => {
    const { fields } = parseFrontmatterBlock("---\nscopeClass: a\nnonsense\n---\nbody");
    expect(fields).toEqual({ scopeClass: "a" });
  });

  test("empty input does not throw", () => {
    expect(parseFrontmatterBlock("").fields).toEqual({});
    expect(parseFrontmatterBlock(undefined as unknown as string).body).toBe("");
  });
});

test.describe("type guards", () => {
  test("isScopeClass accepts exactly the six classes", () => {
    for (const sc of ["a", "b", "c", "d", "d-bis", "e"]) expect(isScopeClass(sc)).toBe(true);
    for (const bad of ["f", "E", "", "core", 1, null, undefined]) expect(isScopeClass(bad)).toBe(false);
  });

  test("isOwnership accepts exactly the five ownerships", () => {
    for (const o of ["bos-core", "user-app", "marketplace", "workflow", "env"]) expect(isOwnership(o)).toBe(true);
    for (const bad of ["core", "", null, 7]) expect(isOwnership(bad)).toBe(false);
  });
});

test.describe("parseDiagnosticsReport", () => {
  test("a complete report parses into routable fields", () => {
    const parsed = parseDiagnosticsReport(VALID);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.frontmatter.scopeClass).toBe("e");
    expect(parsed.frontmatter.ownership).toBe("bos-core");
    expect(parsed.frontmatter.verdict).toContain("genuine gap");
    expect(parsed.body).toContain("os-store.ts:11");
  });

  test("no frontmatter is rejected with a specific reason", () => {
    const parsed = parseDiagnosticsReport("## Investigation\n\nsome prose");
    expect("error" in parsed && parsed.error).toContain("no YAML frontmatter");
  });

  test("an invented scopeClass is rejected, not coerced", () => {
    const parsed = parseDiagnosticsReport("---\nscopeClass: f\nownership: bos-core\nproposedSurface: x\n---\nbody");
    expect("error" in parsed && parsed.error).toContain("scopeClass");
  });

  test("a missing ownership is rejected", () => {
    const parsed = parseDiagnosticsReport("---\nscopeClass: e\nproposedSurface: x\n---\nbody");
    expect("error" in parsed && parsed.error).toContain("ownership");
  });

  test("a missing proposedSurface is rejected — a pipeline with no target is useless", () => {
    const parsed = parseDiagnosticsReport("---\nscopeClass: e\nownership: bos-core\n---\nbody");
    expect("error" in parsed && parsed.error).toContain("proposedSurface");
  });

  test("an empty body is rejected — the narrative IS the report", () => {
    const parsed = parseDiagnosticsReport("---\nscopeClass: e\nownership: bos-core\nproposedSurface: x\n---\n");
    expect("error" in parsed && parsed.error).toContain("body is empty");
  });

  test("several problems are reported together, not one at a time", () => {
    const parsed = parseDiagnosticsReport("---\nscopeClass: zzz\n---\nbody");
    if (!("error" in parsed)) throw new Error("expected a rejection");
    expect(parsed.error).toContain("scopeClass");
    expect(parsed.error).toContain("ownership");
    expect(parsed.error).toContain("proposedSurface");
  });
});

test.describe("renderDiagnosticsReport", () => {
  test("produces a normalized, re-parseable document", () => {
    const rendered = renderDiagnosticsReport(
      {
        caseId: "0042",
        scopeClass: "d-bis",
        ownership: "user-app",
        proposedSurface: 'okf-knowledge-base: services/index.ts (the "ingest" handler)',
        verdict: "genuine gap",
        appId: "okf-knowledge-base",
      },
      "## Investigation\n\nSee `src/x.ts:1`.",
    );
    const parsed = parseDiagnosticsReport(rendered);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.frontmatter.caseId).toBe("0042");
    expect(parsed.frontmatter.scopeClass).toBe("d-bis");
    expect(parsed.frontmatter.appId).toBe("okf-knowledge-base");
    // Quoting matters: the surface contains a colon and quotes of its own.
    expect(parsed.frontmatter.proposedSurface).toContain('the "ingest" handler');
  });

  test("stamps triggeredAt when the caller omits it", () => {
    const rendered = renderDiagnosticsReport(
      { caseId: "1", scopeClass: "a", ownership: "env", proposedSurface: "network" },
      "body",
    );
    expect(rendered).toMatch(/triggeredAt: \d{4}-\d{2}-\d{2}T/);
  });
});

test.describe("hasSourceCitation (FR-007b)", () => {
  test("accepts a path with or without a line number, and a spec reference", () => {
    expect(hasSourceCitation("as shown in src/lib/self-heal/intake.ts:42 the guard runs first")).toBe(true);
    expect(hasSourceCitation("see `seed/agents/conversation-reviewer/AGENT.md`")).toBe(true);
    expect(hasSourceCitation("docs/dev/architecture-overview.md says so")).toBe(true);
    expect(hasSourceCitation("per spec 034 the kernel dispatches")).toBe(true);
  });

  test("rejects an uncited narrative — a claim with no source is a guess", () => {
    expect(hasSourceCitation("the tool layer is probably dropping the parameter somewhere")).toBe(false);
    expect(hasSourceCitation("")).toBe(false);
  });
});

test.describe("reportPathFor", () => {
  test("writes into the same directory as Mode 1 reports (FR-028)", () => {
    expect(reportPathFor("0001")).toBe("/Documents/BOS Improvements/self-heal-0001.md");
  });
});
