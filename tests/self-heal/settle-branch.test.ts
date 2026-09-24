import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import * as intake from "../../src/lib/self-heal/intake";
import { createCase, getCase, updateCase } from "../../src/lib/self-heal/store";
import { computeFailureSignature } from "../../src/lib/self-heal/signature";
import { SELF_HEAL_EVENTS, selfHealBranchFor, type TriggerContext } from "../../src/lib/self-heal/types";
import { useSelfHealTestRoot } from "./_test-env";

// 031-self-healing FR-038(a) — the app-side settlement path.
//
// After the user promotes or discards a preview branch, the topbar / Versions
// tab notifies the spine (`POST /api/self-heal?op=branch-settled`), which lands
// on `settleBranchOutcome`: every `preview-ready` case linked to that branch is
// closed as `resolved` (promoted) or `dismissed` (discarded), with the matching
// lifecycle event. This suite drives the server function directly — the HTTP
// wrapper adds nothing but parameter validation.

const ctx: TriggerContext = { trigger: "hard-error", toolName: "t", errorMessage: "e" };

async function previewReadyCase(title = "t"): Promise<{ id: string; branch: string }> {
  const record = await createCase({ trigger: "hard-error", title, signature: computeFailureSignature(ctx), context: ctx });
  const branch = selfHealBranchFor(record.id);
  await updateCase(record.id, {
    status: "preview-ready",
    activeFeatureBranch: branch,
    fixCommit: "0123456789abcdef0123456789abcdef01234567",
    note: `fix ready on ${branch}`,
  });
  return { id: record.id, branch };
}

async function eventCount(type: string): Promise<number> {
  const api = await import("../../src/lib/events/api");
  return api.query({ type }).events.length;
}

test.describe("settleBranchOutcome (FR-038a)", () => {
  test("promoted: the preview-ready case resolves and fix_promoted is emitted", async () => {
    const root = useSelfHealTestRoot("settle-promoted");
    try {
      const { id, branch } = await previewReadyCase();
      // The events store is a process-wide singleton, so counts are deltas.
      const before = await eventCount(SELF_HEAL_EVENTS.fixPromoted);

      const settled = await intake.settleBranchOutcome(branch, "promoted");
      expect(settled).toBe(1);

      const record = await getCase(id);
      expect(record?.status).toBe("resolved");
      // The transition landed on the timeline, not just the status field.
      expect(record?.timeline.at(-1)?.status).toBe("resolved");

      const api = await import("../../src/lib/events/api");
      const events = api.query({ type: SELF_HEAL_EVENTS.fixPromoted }).events;
      expect(events).toHaveLength(before + 1);
      const full = await api.getEvent(events[0].id);
      expect(full.payload).toMatchObject({ caseId: id, status: "resolved", branch });
    } finally {
      await root.cleanup();
    }
  });

  test("discarded: the preview-ready case is dismissed and fix_discarded is emitted", async () => {
    const root = useSelfHealTestRoot("settle-discarded");
    try {
      const { id, branch } = await previewReadyCase();
      const before = await eventCount(SELF_HEAL_EVENTS.fixDiscarded);

      const settled = await intake.settleBranchOutcome(branch, "discarded");
      expect(settled).toBe(1);
      expect((await getCase(id))?.status).toBe("dismissed");

      const api = await import("../../src/lib/events/api");
      const events = api.query({ type: SELF_HEAL_EVENTS.fixDiscarded }).events;
      expect(events).toHaveLength(before + 1);
      expect((await api.getEvent(events[0].id)).payload).toMatchObject({ caseId: id, status: "dismissed", branch });
    } finally {
      await root.cleanup();
    }
  });

  test("no matching branch is a no-op: count 0, nothing changes, nothing emitted", async () => {
    const root = useSelfHealTestRoot("settle-no-match");
    try {
      const { id } = await previewReadyCase();
      const beforePromoted = await eventCount(SELF_HEAL_EVENTS.fixPromoted);

      const settled = await intake.settleBranchOutcome("bos/testfixture-some-other-branch", "promoted");
      expect(settled).toBe(0);
      expect((await getCase(id))?.status).toBe("preview-ready");
      expect(await eventCount(SELF_HEAL_EVENTS.fixPromoted)).toBe(beforePromoted);
    } finally {
      await root.cleanup();
    }
  });

  test("only preview-ready cases settle — an in-flight case on the same branch is untouched", async () => {
    const root = useSelfHealTestRoot("settle-in-flight");
    try {
      const record = await createCase({
        trigger: "hard-error",
        title: "still building",
        signature: computeFailureSignature(ctx),
        context: ctx,
      });
      const branch = selfHealBranchFor(record.id);
      await updateCase(record.id, { status: "bs-pipeline", activeFeatureBranch: branch });

      const settled = await intake.settleBranchOutcome(branch, "promoted");
      expect(settled).toBe(0);
      expect((await getCase(record.id))?.status).toBe("bs-pipeline");
    } finally {
      await root.cleanup();
    }
  });
});
