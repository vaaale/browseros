import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import * as reentrancy from "../../src/lib/self-heal/reentrancy";
import * as intake from "../../src/lib/self-heal/intake";
import { getCase, listCases } from "../../src/lib/self-heal/store";
import { useSelfHealTestRoot } from "./_test-env";
import type { TriggerContext } from "../../src/lib/self-heal/types";

// 031-self-healing FR-025 / design ADR-4 — the re-entrancy guard.
//
// FR-025's primary protection is BY CONSTRUCTION, not by a check: headless runs
// (the Diagnostician and the autonomous BS pipeline both go through
// `runLocalHeadless`) never receive a `hooks` argument, so they cannot reach the
// trigger-capture plugin at all. What is testable — and what these tests pin —
// are the two backstops for the paths where construction is not enough:
//
//   (a) the conversation marker, for a spine-seeded conversation that a human
//       later drives from the chat UI (that run DOES fire hooks);
//   (b) the event-payload filter in the deterministic front door, which holds
//       regardless of which run path emitted the event.

const HARD: TriggerContext = { trigger: "hard-error", toolName: "file_read", errorMessage: "permission denied" };

test.afterEach(() => {
  intake._setSpineAgentHooksForTests(null);
});

test.describe("guard (a) — the conversation marker", () => {
  test("marking a conversation makes it recognizable by id alone", async () => {
    const root = useSelfHealTestRoot("reentrancy-marker");
    try {
      const { saveConversationMessages } = await import("../../src/lib/assistant/conversation-store");
      await saveConversationMessages("c-self-heal-fix-0001", "build-studio", [
        { id: "m1", role: "user", content: "brief" },
      ]);
      await reentrancy.markSelfHealConversation("c-self-heal-fix-0001", { role: "pipeline", caseId: "0001" });

      const marker = await reentrancy.getSelfHealConversationMarker("c-self-heal-fix-0001");
      expect(marker).toEqual({ role: "pipeline", caseId: "0001" });
      expect(await reentrancy.isSelfHealConversation("c-self-heal-fix-0001")).toBe(true);
    } finally {
      await root.cleanup();
    }
  });

  test("an ordinary conversation carries no marker", async () => {
    const root = useSelfHealTestRoot("reentrancy-unmarked");
    try {
      const { saveConversationMessages } = await import("../../src/lib/assistant/conversation-store");
      await saveConversationMessages("c-user-1", "assistant", [{ id: "m1", role: "user", content: "hi" }]);
      expect(await reentrancy.isSelfHealConversation("c-user-1")).toBe(false);
      expect(await reentrancy.getSelfHealConversationMarker("c-user-1")).toBeUndefined();
    } finally {
      await root.cleanup();
    }
  });

  test("a nonexistent or empty conversation id is not self-heal-origin (and never throws)", async () => {
    const root = useSelfHealTestRoot("reentrancy-missing");
    try {
      expect(await reentrancy.isSelfHealConversation("")).toBe(false);
      expect(await reentrancy.isSelfHealConversation("c-nope")).toBe(false);
      // Marking a conversation that doesn't exist is a no-op, not an error.
      await reentrancy.markSelfHealConversation("c-nope", { role: "pipeline", caseId: "x" });
      expect(await reentrancy.isSelfHealConversation("c-nope")).toBe(false);
    } finally {
      await root.cleanup();
    }
  });

  test("a malformed marker is ignored rather than trusted", async () => {
    const root = useSelfHealTestRoot("reentrancy-malformed");
    try {
      const { saveConversationMessages, patchConversationMeta } = await import(
        "../../src/lib/assistant/conversation-store"
      );
      await saveConversationMessages("c-weird", "assistant", [{ id: "m1", role: "user", content: "hi" }]);
      await patchConversationMeta("c-weird", { selfHeal: { role: "not-a-role", caseId: 7 } });
      expect(await reentrancy.getSelfHealConversationMarker("c-weird")).toBeUndefined();
      expect(await reentrancy.isSelfHealConversation("c-weird")).toBe(false);
    } finally {
      await root.cleanup();
    }
  });

  test("intake refuses a trigger from a self-heal-origin conversation", async () => {
    const root = useSelfHealTestRoot("reentrancy-intake-conv");
    try {
      root.writeConfig({ enabled: true, "triggers.hardError": true });
      intake._setSpineAgentHooksForTests({ diagnose: async () => ({ ok: false }) });
      const { saveConversationMessages } = await import("../../src/lib/assistant/conversation-store");
      await saveConversationMessages("c-self-heal-fix-0001", "build-studio", [
        { id: "m1", role: "user", content: "brief" },
      ]);
      await reentrancy.markSelfHealConversation("c-self-heal-fix-0001", { role: "pipeline", caseId: "0001" });

      const outcome = await intake.selfHealIntake(
        { ...HARD, conversationId: "c-self-heal-fix-0001" },
        { awaitDiagnosis: true },
      );
      expect(outcome.action).toBe("reentrancy-skipped");
      expect(await listCases()).toEqual([]);
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("guard (b) — the event-payload filter", () => {
  test("a payload carrying selfHeal.role is self-heal-origin", () => {
    expect(reentrancy.isSelfHealOriginPayload({ selfHeal: { role: "lifecycle", caseId: "0001" } })).toBe(true);
    expect(reentrancy.isSelfHealOriginPayload({ selfHeal: { role: "pipeline" } })).toBe(true);
  });

  test("anything else is not", () => {
    expect(reentrancy.isSelfHealOriginPayload({})).toBe(false);
    expect(reentrancy.isSelfHealOriginPayload({ selfHeal: {} })).toBe(false);
    expect(reentrancy.isSelfHealOriginPayload({ selfHeal: "yes" })).toBe(false);
    expect(reentrancy.isSelfHealOriginPayload({ selfHeal: { caseId: "x" } })).toBe(false);
    expect(reentrancy.isSelfHealOriginPayload(null)).toBe(false);
    expect(reentrancy.isSelfHealOriginPayload(undefined)).toBe(false);
    expect(reentrancy.isSelfHealOriginPayload("string")).toBe(false);
  });

  test("filterSelfHealEvents drops our own events from a batch", () => {
    const events = [
      { id: "1", payload: { selfHeal: { role: "lifecycle", caseId: "0001" } } },
      { id: "2", payload: { component: "assistant" } },
      { id: "3", payload: undefined },
    ];
    expect(reentrancy.filterSelfHealEvents(events).map((e) => e.id)).toEqual(["2", "3"]);
  });
});

test.describe("a failing Diagnostician creates NO new case (FR-025)", () => {
  test("the failure is recorded on the case it belongs to and nowhere else", async () => {
    const root = useSelfHealTestRoot("reentrancy-diag-failure");
    try {
      root.writeConfig({ enabled: true, "triggers.hardError": true, "triggers.explicit": true });
      intake._setSpineAgentHooksForTests({
        diagnose: async (caseId) => {
          const { updateCase } = await import("../../src/lib/self-heal/store");
          await updateCase(caseId, { status: "failed", error: "the Diagnostician run blew up" });
          return { ok: false, error: "the Diagnostician run blew up" };
        },
      });

      const outcome = await intake.selfHealIntake(HARD, { awaitDiagnosis: true });
      if (outcome.action !== "created") throw new Error("expected a case");
      expect((await getCase(outcome.caseId))?.status).toBe("failed");
      // Exactly one case: the Diagnostician's own failure did not become a
      // second self-heal case.
      expect(await listCases()).toHaveLength(1);
    } finally {
      await root.cleanup();
    }
  });
});
