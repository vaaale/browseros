import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { casePayload, emitSelfHeal, summaryFor } from "../../src/lib/self-heal/events";
import { markSelfHealConversation } from "../../src/lib/self-heal/reentrancy";
import { tokensSpentToday } from "../../src/lib/self-heal/cost";
import { sweepSuspendedTimeouts, enqueueCost } from "../../src/lib/self-heal/queue";
import { appendCostLedger, createCase, getCase, updateCase, withIndex } from "../../src/lib/self-heal/store";
import { computeFailureSignature } from "../../src/lib/self-heal/signature";
import { parseFrontmatterBlock } from "../../src/lib/self-heal/report";
import { SELF_HEAL_EVENTS, humanCaseId } from "../../src/lib/self-heal/types";
import { useSelfHealTestRoot } from "./_test-env";
import type { TriggerContext } from "../../src/lib/self-heal/types";

// Edge branches across the smaller spine modules. Each one is a "what happens
// when the interesting thing is MISSING" path — an absent optional field, an
// event kernel that refuses, a case that vanished mid-sweep. They are cheap to
// get wrong and, being the failure paths, are exactly the ones never exercised
// by a happy-path run.

const ctx: TriggerContext = { trigger: "hard-error", toolName: "t", errorMessage: "e" };

async function make(title = "t") {
  return createCase({ trigger: "hard-error", title, signature: computeFailureSignature(ctx), context: ctx });
}

test.describe("event emission (FR-026)", () => {
  test("casePayload carries the routing fields, omitting what is not known yet", async () => {
    const root = useSelfHealTestRoot("events-payload-minimal");
    try {
      const record = await make("a fresh case");
      const payload = casePayload(record);
      expect(payload).toMatchObject({
        caseId: record.id,
        humanId: humanCaseId(record.id),
        trigger: "hard-error",
        status: "new",
        title: "a fresh case",
        dedupeKey: record.signature.dedupeKey,
      });
      // Not diagnosed yet ⇒ no verdict fields invented.
      expect(payload.scopeClass).toBeUndefined();
      expect(payload.ownership).toBeUndefined();
      expect(payload.proposedSurface).toBeUndefined();
      expect(payload.reportPath).toBeUndefined();
      // The role marker is what the intake filter looks for (ADR-4 guard b).
      expect(payload.selfHeal).toEqual({ role: "lifecycle", caseId: record.id });
    } finally {
      await root.cleanup();
    }
  });

  test("casePayload includes every verdict field once they exist, and merges extras", async () => {
    const root = useSelfHealTestRoot("events-payload-full");
    try {
      const record = await make();
      const diagnosed = await updateCase(record.id, {
        status: "diagnosed",
        scopeClass: "e",
        ownership: "bos-core",
        proposedSurface: "src/x.ts",
        reportPath: "/Documents/BOS Improvements/self-heal-0001.md",
      });
      if (!diagnosed) throw new Error("missing case");
      const payload = casePayload(diagnosed, { branch: "bos/self-heal-0001" });
      expect(payload.scopeClass).toBe("e");
      expect(payload.ownership).toBe("bos-core");
      expect(payload.proposedSurface).toBe("src/x.ts");
      expect(payload.reportPath).toContain("self-heal-0001.md");
      expect(payload.branch).toBe("bos/self-heal-0001");
    } finally {
      await root.cleanup();
    }
  });

  test("summaryFor reads as a sentence with the human id", async () => {
    const root = useSelfHealTestRoot("events-summary");
    try {
      const record = await make("bos_app_launch drops params");
      expect(summaryFor(record, "created")).toBe(`${humanCaseId(record.id)} created — bos_app_launch drops params`);
    } finally {
      await root.cleanup();
    }
  });

  test("an emit refused by the kernel is logged, not thrown — a notification failure never rolls back a transition", async () => {
    const root = useSelfHealTestRoot("events-emit-refused");
    try {
      // An oversized payload is rejected by the event API's validation.
      const id = await emitSelfHeal(SELF_HEAL_EVENTS.caseCreated, { blob: "x".repeat(1_100_000) });
      expect(id).toBeUndefined();
    } finally {
      await root.cleanup();
    }
  });

  test("a successful emit returns the event id", async () => {
    const root = useSelfHealTestRoot("events-emit-ok");
    try {
      const id = await emitSelfHeal(SELF_HEAL_EVENTS.caseCreated, { caseId: "0001", summary: "s" });
      expect(typeof id).toBe("string");
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("cost-ledger edges", () => {
  test("a ledger entry with a missing token count contributes nothing rather than NaN", async () => {
    const root = useSelfHealTestRoot("cost-nan");
    try {
      await appendCostLedger({ caseId: "0001", role: "pipeline", tokens: undefined as unknown as number, at: Date.now() });
      await appendCostLedger({ caseId: "0002", role: "pipeline", tokens: 10, at: Date.now() });
      expect(await tokensSpentToday()).toBe(10);
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("queue edges", () => {
  test("an eviction whose case file is gone still emits and does not throw", async () => {
    const root = useSelfHealTestRoot("queue-evict-missing-case");
    try {
      root.writeConfig({ enabled: true, costQueueMax: 1 });
      const keep = await make("keep");
      // A queue entry pointing at a case that no longer exists on disk.
      await withIndex((index) => {
        index.costQueue.push({ caseId: "9999", at: Date.now() - 1_000 });
      });
      const evicted = await enqueueCost(keep.id);
      expect(evicted.map((e) => e.caseId)).toEqual(["9999"]);
    } finally {
      await root.cleanup();
    }
  });

  test("the sweep skips an index entry whose case moved on since the index was read", async () => {
    const root = useSelfHealTestRoot("queue-sweep-stale-index");
    try {
      root.writeConfig({ enabled: true, suspendedTimeoutDays: 1 });
      const record = await make();
      await updateCase(record.id, { status: "suspended", suspendedAt: Date.now() - 5 * 86_400_000 });
      // The index says `suspended`; the case record says otherwise. The record
      // wins — the index is the fast path, not the truth.
      await updateCase(record.id, { status: "dismissed" });
      await withIndex((index) => {
        index.cases[record.id] = { status: "suspended", updatedAt: Date.now() };
      });
      expect(await sweepSuspendedTimeouts()).toEqual([]);
      expect((await getCase(record.id))?.status).toBe("dismissed");
    } finally {
      await root.cleanup();
    }
  });

  test("the sweep skips an index entry with no case file at all", async () => {
    const root = useSelfHealTestRoot("queue-sweep-ghost");
    try {
      root.writeConfig({ enabled: true, suspendedTimeoutDays: 1 });
      await withIndex((index) => {
        index.cases["9999"] = { status: "suspended", updatedAt: Date.now() - 5 * 86_400_000 };
      });
      expect(await sweepSuspendedTimeouts()).toEqual([]);
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("re-entrancy marker edges", () => {
  test("marking with an empty conversation id is a no-op", async () => {
    const root = useSelfHealTestRoot("reentrancy-empty-mark");
    try {
      await markSelfHealConversation("", { role: "pipeline", caseId: "0001" });
      // Nothing to assert beyond "it did not throw"; the guard exists so a
      // caller with no conversation cannot write a stray file.
    } finally {
      await root.cleanup();
    }
  });

  test("a marker with a non-string caseId is normalized to an empty id, not dropped", async () => {
    const root = useSelfHealTestRoot("reentrancy-bad-caseid");
    try {
      const { saveConversationMessages, patchConversationMeta } = await import(
        "../../src/lib/assistant/conversation-store"
      );
      const { getSelfHealConversationMarker } = await import("../../src/lib/self-heal/reentrancy");
      await saveConversationMessages("c-x", "assistant", [{ id: "m", role: "user", content: "hi" }]);
      await patchConversationMeta("c-x", { selfHeal: { role: "pipeline" } });
      // The ROLE is what the guard keys off, so a missing caseId must still
      // count as self-heal-origin rather than letting the run through.
      expect(await getSelfHealConversationMarker("c-x")).toEqual({ role: "pipeline", caseId: "" });
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("frontmatter parser edges", () => {
  test("a single-quoted value is unwrapped plainly (the shape an LLM tends to write)", () => {
    const { fields } = parseFrontmatterBlock("---\nproposedSurface: 'src/x.ts'\n---\nbody");
    expect(fields.proposedSurface).toBe("src/x.ts");
  });

  test("a double-quoted value that is not valid JSON still unwraps", () => {
    const { fields } = parseFrontmatterBlock('---\nproposedSurface: "src\\x.ts"\n---\nbody');
    expect(fields.proposedSurface).toBe("src\\x.ts");
  });

  test("a bare value is taken as-is", () => {
    const { fields } = parseFrontmatterBlock("---\nscopeClass: d-bis\n---\nbody");
    expect(fields.scopeClass).toBe("d-bis");
  });

  test("a lone `\"` is not mistaken for a quoted string", () => {
    const { fields } = parseFrontmatterBlock('---\nverdict: "\n---\nbody');
    expect(fields.verdict).toBe('"');
  });
});
