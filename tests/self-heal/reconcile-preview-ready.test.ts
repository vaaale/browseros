import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import * as intake from "../../src/lib/self-heal/intake";
import { createCase, getCase, updateCase } from "../../src/lib/self-heal/store";
import { computeFailureSignature } from "../../src/lib/self-heal/signature";
import { SELF_HEAL_EVENTS, selfHealBranchFor, type TriggerContext } from "../../src/lib/self-heal/types";
import { useSelfHealTestRoot } from "./_test-env";

// 031-self-healing FR-038(b) — the boot-reconcile backstop.
//
// The app-side branch-settled notification can be lost (browser closed before
// the fetch, promote restarting base mid-request), so `reconcileInFlightCases`
// sweeps every `preview-ready` case on boot: a case whose linked branch no
// longer exists in the Supervisor's branch list is settled by git ancestry —
// `fixCommit` an ancestor of base means the branch was merged (promoted →
// `resolved`), otherwise it was deleted unmerged (discarded → `dismissed`).
//
// The Supervisor/git facts are stubbed through `_setBranchFactsForTests` — the
// same seam discipline as `_setSpineAgentHooksForTests` — so the sweep's
// decision tree runs hermetically.

const ctx: TriggerContext = { trigger: "hard-error", toolName: "t", errorMessage: "e" };
const FIX_COMMIT = "0123456789abcdef0123456789abcdef01234567";

async function previewReadyCase(fixCommit: string | null = FIX_COMMIT): Promise<{ id: string; branch: string }> {
  const record = await createCase({ trigger: "hard-error", title: "t", signature: computeFailureSignature(ctx), context: ctx });
  const branch = selfHealBranchFor(record.id);
  await updateCase(record.id, {
    status: "preview-ready",
    activeFeatureBranch: branch,
    ...(fixCommit ? { fixCommit } : {}),
    note: `fix ready on ${branch}`,
  });
  return { id: record.id, branch };
}

async function eventCount(type: string): Promise<number> {
  const api = await import("../../src/lib/events/api");
  return api.query({ type }).events.length;
}

test.afterEach(() => {
  intake._setBranchFactsForTests(null);
});

test.describe("fixCommit recording (FR-038)", () => {
  test("completeFix stamps the branch head SHA on the case", async () => {
    const root = useSelfHealTestRoot("complete-fix-commit");
    try {
      const record = await createCase({ trigger: "hard-error", title: "t", signature: computeFailureSignature(ctx), context: ctx });
      const branch = selfHealBranchFor(record.id);
      await updateCase(record.id, { status: "bs-pipeline", activeFeatureBranch: branch, scopeClass: "e" });
      intake._setBranchFactsForTests({ branchHeadSha: async (b) => (b === branch ? FIX_COMMIT : undefined) });

      const done = await intake.completeFix({ caseId: record.id, branch, summary: "s", skipPreviewCheck: true });
      expect(done.ok).toBe(true);
      const after = await getCase(record.id);
      expect(after?.status).toBe("preview-ready");
      expect(after?.fixCommit).toBe(FIX_COMMIT);
    } finally {
      await root.cleanup();
    }
  });

  test("a class d-bis fix (no branch) records no fixCommit and still completes", async () => {
    const root = useSelfHealTestRoot("complete-fix-no-branch");
    try {
      const record = await createCase({ trigger: "hard-error", title: "t", signature: computeFailureSignature(ctx), context: ctx });
      await updateCase(record.id, { status: "bs-pipeline", scopeClass: "d-bis", appId: "some-app" });
      intake._setBranchFactsForTests({
        branchHeadSha: async () => {
          throw new Error("no branch — the SHA lookup must not run");
        },
      });

      const done = await intake.completeFix({ caseId: record.id, appId: "some-app", summary: "s" });
      expect(done.ok).toBe(true);
      expect((await getCase(record.id))?.fixCommit).toBeUndefined();
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("the preview-ready boot sweep (FR-038b)", () => {
  test("branch gone + fixCommit an ancestor of base → resolved + fix_promoted", async () => {
    const root = useSelfHealTestRoot("reconcile-pr-promoted");
    try {
      const { id } = await previewReadyCase();
      const before = await eventCount(SELF_HEAL_EVENTS.fixPromoted);
      intake._setBranchFactsForTests({
        listBranches: async () => ["main"],
        isAncestorOfBase: async (sha) => sha === FIX_COMMIT,
      });

      const summary = await intake.reconcileInFlightCases();
      expect(summary.settled).toContain(id);
      expect((await getCase(id))?.status).toBe("resolved");
      expect(await eventCount(SELF_HEAL_EVENTS.fixPromoted)).toBe(before + 1);
    } finally {
      await root.cleanup();
    }
  });

  test("branch gone + fixCommit NOT an ancestor → dismissed + fix_discarded", async () => {
    const root = useSelfHealTestRoot("reconcile-pr-discarded");
    try {
      const { id } = await previewReadyCase();
      const before = await eventCount(SELF_HEAL_EVENTS.fixDiscarded);
      intake._setBranchFactsForTests({
        listBranches: async () => ["main"],
        isAncestorOfBase: async () => false,
      });

      const summary = await intake.reconcileInFlightCases();
      expect(summary.settled).toContain(id);
      expect((await getCase(id))?.status).toBe("dismissed");
      expect(await eventCount(SELF_HEAL_EVENTS.fixDiscarded)).toBe(before + 1);
    } finally {
      await root.cleanup();
    }
  });

  test("branch still in the Supervisor's list → the case is left alone", async () => {
    const root = useSelfHealTestRoot("reconcile-pr-alive");
    try {
      const { id, branch } = await previewReadyCase();
      intake._setBranchFactsForTests({
        listBranches: async () => ["main", branch],
        isAncestorOfBase: async () => {
          throw new Error("ancestry must not be checked while the branch still exists");
        },
      });

      const summary = await intake.reconcileInFlightCases();
      expect(summary.settled).toEqual([]);
      expect((await getCase(id))?.status).toBe("preview-ready");
    } finally {
      await root.cleanup();
    }
  });

  test("not under the Supervisor (no branch list) → nothing is settled", async () => {
    const root = useSelfHealTestRoot("reconcile-pr-no-supervisor");
    try {
      const { id } = await previewReadyCase();
      intake._setBranchFactsForTests({
        listBranches: async () => undefined,
        isAncestorOfBase: async () => true,
      });

      const summary = await intake.reconcileInFlightCases();
      expect(summary.settled).toEqual([]);
      expect((await getCase(id))?.status).toBe("preview-ready");
    } finally {
      await root.cleanup();
    }
  });

  test("branch gone with NO recorded fixCommit → dismissed (never resolved on a guess)", async () => {
    const root = useSelfHealTestRoot("reconcile-pr-no-commit");
    try {
      const { id } = await previewReadyCase(null);
      intake._setBranchFactsForTests({
        listBranches: async () => ["main"],
        isAncestorOfBase: async () => true,
      });

      const summary = await intake.reconcileInFlightCases();
      expect(summary.settled).toContain(id);
      expect((await getCase(id))?.status).toBe("dismissed");
    } finally {
      await root.cleanup();
    }
  });
});
