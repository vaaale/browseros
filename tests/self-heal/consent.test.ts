import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import * as consent from "../../src/lib/self-heal/consent";
import { createCase, getCase, updateCase } from "../../src/lib/self-heal/store";
import { computeFailureSignature } from "../../src/lib/self-heal/signature";
import { useSelfHealTestRoot } from "./_test-env";
import type { ProposedEdit, ScopeClass, TriggerContext } from "../../src/lib/self-heal/types";

// 031-self-healing FR-010/FR-011/FR-022c.
//
// Classes b and c are the only fixes BOS applies IN PLACE — there is no preview
// to promote afterwards, so this consent gate is the ONLY checkpoint. These
// tests exist to pin the gate: an approved edit must actually change the file,
// and a case that was never consented must leave the file byte-identical.

const ctx: TriggerContext = { trigger: "hard-error", toolName: "file_read", errorMessage: "wrong path taught" };

async function caseWith(scopeClass: ScopeClass, edit?: ProposedEdit, status: "awaiting-consent" | "diagnosed" = "awaiting-consent") {
  const record = await createCase({
    trigger: "hard-error",
    title: "t",
    signature: computeFailureSignature(ctx),
    context: ctx,
  });
  await updateCase(record.id, { status, scopeClass, ...(edit ? { proposedEdit: edit } : {}) });
  return record.id;
}

function seedSkill(dir: string, id: string, body: string): string {
  const skillDir = join(dir, "skills", id);
  mkdirSync(skillDir, { recursive: true });
  const file = join(skillDir, "SKILL.md");
  writeFileSync(file, `---\nname: ${id}\ndescription: test skill\n---\n\n${body}\n`, "utf8");
  return file;
}

function seedWorkflow(dir: string, name: string, json: unknown): string {
  const wfDir = join(dir, "vfs", "Workflows");
  mkdirSync(wfDir, { recursive: true });
  const file = join(wfDir, name);
  writeFileSync(file, JSON.stringify(json, null, 2), "utf8");
  return file;
}

test.describe("applyApprovedEdit — class b (a skill patch)", () => {
  test("an approved edit actually changes the skill file and closes the case", async () => {
    const root = useSelfHealTestRoot("consent-skill");
    try {
      const file = seedSkill(root.dir, "agent-behavior-review", 'Always call file_read({path:"~/docs/x"}).');
      const caseId = await caseWith("b", {
        artifactType: "skill",
        target: "agent-behavior-review",
        before: 'file_read({path:"~/docs/x"})',
        after: 'file_read({path:"/Documents/x"})',
        rationale: "the VFS has no ~ — the tilde path silently misses",
      });

      const outcome = await consent.applyApprovedEdit(caseId);
      expect(outcome.ok).toBe(true);
      expect(readFileSync(file, "utf8")).toContain('file_read({path:"/Documents/x"})');
      expect(readFileSync(file, "utf8")).not.toContain("~/docs/x");

      const record = await getCase(caseId);
      expect(record?.status).toBe("applied");
      expect(record?.timeline.at(-1)?.note).toContain("agent-behavior-review");
    } finally {
      await root.cleanup();
    }
  });

  test("an edit whose `before` text is gone is refused and the case stays open", async () => {
    const root = useSelfHealTestRoot("consent-skill-stale");
    try {
      const file = seedSkill(root.dir, "agent-behavior-review", "Some other body entirely.");
      const before = readFileSync(file, "utf8");
      const caseId = await caseWith("b", {
        artifactType: "skill",
        target: "agent-behavior-review",
        before: "text that is not there",
        after: "replacement",
      });

      const outcome = await consent.applyApprovedEdit(caseId);
      expect(outcome.ok).toBe(false);
      expect(readFileSync(file, "utf8")).toBe(before);
      // Still open, with the reason recorded, so the user can see and dismiss it.
      const record = await getCase(caseId);
      expect(record?.status).toBe("awaiting-consent");
      expect(record?.timeline.at(-1)?.note).toContain("could not be applied");
    } finally {
      await root.cleanup();
    }
  });

  test("an edit naming a skill that does not exist is refused", async () => {
    const root = useSelfHealTestRoot("consent-skill-missing");
    try {
      const caseId = await caseWith("b", { artifactType: "skill", target: "no-such-skill", before: "a", after: "b" });
      const outcome = await consent.applyApprovedEdit(caseId);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toContain("no-such-skill");
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("applyApprovedEdit — class c (a workflow definition patch)", () => {
  test("an approved edit changes the workflow definition", async () => {
    const root = useSelfHealTestRoot("consent-workflow");
    try {
      const file = seedWorkflow(root.dir, "daily-review-workflow.json", { id: "daily-review", timeoutMs: 10000 });
      const caseId = await caseWith("c", {
        artifactType: "workflow",
        target: "/Workflows/daily-review-workflow.json",
        before: '"timeoutMs": 10000',
        after: '"timeoutMs": 120000',
      });

      const outcome = await consent.applyApprovedEdit(caseId);
      expect(outcome.ok).toBe(true);
      expect(JSON.parse(readFileSync(file, "utf8")).timeoutMs).toBe(120000);
      expect((await getCase(caseId))?.status).toBe("applied");
    } finally {
      await root.cleanup();
    }
  });

  test("an edit that would produce invalid JSON is refused (a broken workflow is worse than an unfixed one)", async () => {
    const root = useSelfHealTestRoot("consent-workflow-invalid");
    try {
      const file = seedWorkflow(root.dir, "daily-review-workflow.json", { id: "daily-review", timeoutMs: 10000 });
      const original = readFileSync(file, "utf8");
      const caseId = await caseWith("c", {
        artifactType: "workflow",
        target: "/Workflows/daily-review-workflow.json",
        before: '"timeoutMs": 10000',
        after: '"timeoutMs": ',
      });

      const outcome = await consent.applyApprovedEdit(caseId);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toContain("invalid JSON");
      expect(readFileSync(file, "utf8")).toBe(original);
    } finally {
      await root.cleanup();
    }
  });

  test("a target outside /Workflows/ is refused — the edit cannot reach anything else", async () => {
    const root = useSelfHealTestRoot("consent-workflow-escape");
    try {
      for (const target of ["/Documents/secrets.json", "/Workflows/../Documents/x.json", "/Workflows/notjson.txt"]) {
        const caseId = await caseWith("c", { artifactType: "workflow", target, before: "a", after: "b" });
        const outcome = await consent.applyApprovedEdit(caseId);
        expect(outcome.ok).toBe(false);
      }
    } finally {
      await root.cleanup();
    }
  });

  test("a missing workflow file is refused", async () => {
    const root = useSelfHealTestRoot("consent-workflow-missing");
    try {
      const caseId = await caseWith("c", {
        artifactType: "workflow",
        target: "/Workflows/absent-workflow.json",
        before: "a",
        after: "b",
      });
      const outcome = await consent.applyApprovedEdit(caseId);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toContain("no workflow definition");
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("the consent gate itself", () => {
  test("a case that is NOT awaiting consent changes nothing", async () => {
    const root = useSelfHealTestRoot("consent-gate-status");
    try {
      const file = seedSkill(root.dir, "s1", "before-text");
      const original = readFileSync(file, "utf8");
      // Diagnosed but never routed to consent — the gate must hold.
      const caseId = await caseWith("b", { artifactType: "skill", target: "s1", before: "before-text", after: "after-text" }, "diagnosed");

      const outcome = await consent.applyApprovedEdit(caseId);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toContain("not awaiting consent");
      expect(readFileSync(file, "utf8")).toBe(original);
    } finally {
      await root.cleanup();
    }
  });

  test("an already-applied case cannot be applied twice", async () => {
    const root = useSelfHealTestRoot("consent-gate-twice");
    try {
      seedSkill(root.dir, "s1", "one two");
      const caseId = await caseWith("b", { artifactType: "skill", target: "s1", before: "one", after: "ONE" });
      expect((await consent.applyApprovedEdit(caseId)).ok).toBe(true);
      const second = await consent.applyApprovedEdit(caseId);
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.error).toContain("applied");
    } finally {
      await root.cleanup();
    }
  });

  test("a case with no proposed edit is refused rather than guessed at", async () => {
    const root = useSelfHealTestRoot("consent-gate-noedit");
    try {
      const caseId = await caseWith("b");
      const outcome = await consent.applyApprovedEdit(caseId);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toContain("no proposed edit");
    } finally {
      await root.cleanup();
    }
  });

  test("an unknown case id is refused", async () => {
    const root = useSelfHealTestRoot("consent-gate-unknown");
    try {
      expect((await consent.applyApprovedEdit("nope")).ok).toBe(false);
      expect((await consent.dismissCase("nope")).ok).toBe(false);
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("dismissCase", () => {
  test("dismissing closes the case terminally without applying anything", async () => {
    const root = useSelfHealTestRoot("consent-dismiss");
    try {
      const file = seedSkill(root.dir, "s1", "untouched");
      const caseId = await caseWith("b", { artifactType: "skill", target: "s1", before: "untouched", after: "touched" });

      const outcome = await consent.dismissCase(caseId, "not worth it");
      expect(outcome.ok).toBe(true);
      expect(readFileSync(file, "utf8")).toContain("untouched");
      const record = await getCase(caseId);
      expect(record?.status).toBe("dismissed");
      expect(record?.timeline.at(-1)?.note).toContain("not worth it");
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("consent-flow edge branches", () => {
  test("dismissing with no reason records the default note", async () => {
    const root = useSelfHealTestRoot("consent-dismiss-default");
    try {
      const caseId = await caseWith("b");
      const outcome = await consent.dismissCase(caseId);
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.target).toBe("");
      expect((await getCase(caseId))?.timeline.at(-1)?.note).toBe("dismissed by the user");
    } finally {
      await root.cleanup();
    }
  });

  test("dismissing the case that holds the pipeline slot frees it for the next one", async () => {
    const root = useSelfHealTestRoot("consent-dismiss-slot");
    try {
      const caseId = await caseWith("e", undefined, "awaiting-consent");
      const { claimInFlightSlot, readIndex } = await import("../../src/lib/self-heal/store");
      await claimInFlightSlot(caseId);
      await consent.dismissCase(caseId, "not worth building");
      expect((await readIndex()).inFlightSlowPathCaseId).toBeNull();
    } finally {
      await root.cleanup();
    }
  });

  test("a workflow edit whose before-text is absent is refused before any write", async () => {
    const root = useSelfHealTestRoot("consent-workflow-stale");
    try {
      const file = seedWorkflow(root.dir, "x-workflow.json", { id: "x", timeoutMs: 1 });
      const original = readFileSync(file, "utf8");
      const caseId = await caseWith("c", {
        artifactType: "workflow",
        target: "/Workflows/x-workflow.json",
        before: '"timeoutMs": 999',
        after: '"timeoutMs": 5',
      });
      const outcome = await consent.applyApprovedEdit(caseId);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toContain("changed since diagnosis");
      expect(readFileSync(file, "utf8")).toBe(original);
    } finally {
      await root.cleanup();
    }
  });

  test("a skill edit with a rationale still applies (the rationale is display only)", async () => {
    const root = useSelfHealTestRoot("consent-rationale");
    try {
      const file = seedSkill(root.dir, "s2", "old-body");
      const caseId = await caseWith("b", {
        artifactType: "skill",
        target: "s2",
        before: "old-body",
        after: "new-body",
        rationale: "because",
      });
      expect((await consent.applyApprovedEdit(caseId)).ok).toBe(true);
      expect(readFileSync(file, "utf8")).toContain("new-body");
    } finally {
      await root.cleanup();
    }
  });
});
