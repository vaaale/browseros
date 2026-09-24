import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import * as queue from "../../src/lib/self-heal/queue";
import { createCase, getCase, readIndex, updateCase, withIndex } from "../../src/lib/self-heal/store";
import { computeFailureSignature } from "../../src/lib/self-heal/signature";
import { useSelfHealTestRoot } from "./_test-env";
import type { TriggerContext } from "../../src/lib/self-heal/types";

// 031-self-healing FR-020 (bounded cost queue) + FR-015c/FR-016 (the slow-path
// FIFO and the suspended-timeout sweep), design ADR-9.
//
// The invariant these tests exist for: nothing is EVER silently dropped. Every
// eviction and every timeout leaves a terminal case and an announced event, so
// a case that disappeared from a queue is always accounted for.

const DAY = 86_400_000;

async function make(label: string) {
  const ctx: TriggerContext = { trigger: "hard-error", toolName: "t", errorMessage: label };
  return createCase({ trigger: "hard-error", title: label, signature: computeFailureSignature(ctx), context: ctx });
}

test.describe("the cost queue (FR-020)", () => {
  test("enqueue is idempotent", async () => {
    const root = useSelfHealTestRoot("queue-cost-idem");
    try {
      const a = await make("a");
      await queue.enqueueCost(a.id);
      await queue.enqueueCost(a.id);
      expect(await queue.costQueueLength()).toBe(1);
    } finally {
      await root.cleanup();
    }
  });

  test("dequeue is FIFO", async () => {
    const root = useSelfHealTestRoot("queue-cost-fifo");
    try {
      const a = await make("a");
      const b = await make("b");
      await queue.enqueueCost(a.id);
      await queue.enqueueCost(b.id);
      expect(await queue.dequeueCost()).toBe(a.id);
      expect(await queue.dequeueCost()).toBe(b.id);
      expect(await queue.dequeueCost()).toBeUndefined();
    } finally {
      await root.cleanup();
    }
  });

  test("the size bound evicts the OLDEST, and the eviction is announced on the case", async () => {
    const root = useSelfHealTestRoot("queue-cost-bound");
    try {
      root.writeConfig({ enabled: true, costQueueMax: 2 });
      const a = await make("a");
      const b = await make("b");
      const c = await make("c");
      await queue.enqueueCost(a.id);
      await queue.enqueueCost(b.id);
      const evicted = await queue.enqueueCost(c.id);

      expect(evicted.map((e) => e.caseId)).toEqual([a.id]);
      expect(await queue.costQueueLength()).toBe(2);
      // Not silently dropped: the evicted case is terminal and says why.
      const gone = await getCase(a.id);
      expect(gone?.status).toBe("abandoned");
      expect(gone?.error).toContain("queue full");
      expect(gone?.timeline.at(-1)?.note).toContain("evicted");
    } finally {
      await root.cleanup();
    }
  });

  test("the TTL evicts anything queued too long, regardless of position", async () => {
    const root = useSelfHealTestRoot("queue-cost-ttl");
    try {
      root.writeConfig({ enabled: true, costQueueTtlDays: 7 });
      const old = await make("old");
      const fresh = await make("fresh");
      await queue.enqueueCost(old.id);
      await queue.enqueueCost(fresh.id);
      // Back-date the first entry past the TTL.
      await withIndex((index) => {
        index.costQueue[0].at = Date.now() - 8 * DAY;
      });

      const evicted = await queue.sweepCostQueueTtl();
      expect(evicted.map((e) => e.caseId)).toEqual([old.id]);
      expect((await readIndex()).costQueue.map((e) => e.caseId)).toEqual([fresh.id]);
      expect((await getCase(old.id))?.status).toBe("abandoned");
      expect((await getCase(old.id))?.error).toContain("older than 7d");
    } finally {
      await root.cleanup();
    }
  });

  test("dequeue sweeps the TTL first, so a stale head is never handed out", async () => {
    const root = useSelfHealTestRoot("queue-cost-dequeue-ttl");
    try {
      root.writeConfig({ enabled: true, costQueueTtlDays: 1 });
      const old = await make("old");
      const fresh = await make("fresh");
      await queue.enqueueCost(old.id);
      await queue.enqueueCost(fresh.id);
      await withIndex((index) => {
        index.costQueue[0].at = Date.now() - 3 * DAY;
      });
      expect(await queue.dequeueCost()).toBe(fresh.id);
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("the slow-path FIFO (FR-015c)", () => {
  test("enqueue reports the queue position and is idempotent", async () => {
    const root = useSelfHealTestRoot("queue-slow-position");
    try {
      const a = await make("a");
      const b = await make("b");
      expect(await queue.enqueueSlow(a.id)).toBe(1);
      expect(await queue.enqueueSlow(b.id)).toBe(2);
      expect(await queue.enqueueSlow(a.id)).toBe(1); // still first, not re-added
      expect(await queue.slowQueueIds()).toEqual([a.id, b.id]);
    } finally {
      await root.cleanup();
    }
  });

  test("dequeue is FIFO and has NO TTL — escalated work is never dropped for waiting", async () => {
    const root = useSelfHealTestRoot("queue-slow-fifo");
    try {
      const a = await make("a");
      const b = await make("b");
      await queue.enqueueSlow(a.id);
      await queue.enqueueSlow(b.id);
      await withIndex((index) => {
        index.slowQueue[0].at = Date.now() - 60 * DAY;
      });
      expect(await queue.dequeueSlow()).toBe(a.id);
      expect(await queue.dequeueSlow()).toBe(b.id);
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("the suspended-timeout sweep (ADR-9)", () => {
  test("a case suspended past the timeout becomes abandoned and frees the slot", async () => {
    const root = useSelfHealTestRoot("queue-suspend-sweep");
    try {
      root.writeConfig({ enabled: true, suspendedTimeoutDays: 7 });
      const record = await make("waiting");
      await withIndex((index) => {
        index.inFlightSlowPathCaseId = record.id;
      });
      await updateCase(record.id, {
        status: "suspended",
        suspendedAt: Date.now() - 8 * DAY,
        pendingQuestion: "which surface?",
      });

      const abandoned = await queue.sweepSuspendedTimeouts();
      expect(abandoned).toEqual([record.id]);
      const after = await getCase(record.id);
      expect(after?.status).toBe("abandoned");
      expect(after?.error).toContain("7 day");
      // The slot is what a suspended case was holding — it must come back.
      expect((await readIndex()).inFlightSlowPathCaseId).toBeNull();
    } finally {
      await root.cleanup();
    }
  });

  test("a case suspended INSIDE the timeout is left alone", async () => {
    const root = useSelfHealTestRoot("queue-suspend-keep");
    try {
      root.writeConfig({ enabled: true, suspendedTimeoutDays: 7 });
      const record = await make("waiting");
      await updateCase(record.id, { status: "suspended", suspendedAt: Date.now() - 2 * DAY });
      expect(await queue.sweepSuspendedTimeouts()).toEqual([]);
      expect((await getCase(record.id))?.status).toBe("suspended");
    } finally {
      await root.cleanup();
    }
  });

  test("cases in other states are never swept", async () => {
    const root = useSelfHealTestRoot("queue-suspend-other");
    try {
      const record = await make("running");
      await updateCase(record.id, { status: "bs-pipeline" });
      expect(await queue.sweepSuspendedTimeouts()).toEqual([]);
      expect((await getCase(record.id))?.status).toBe("bs-pipeline");
    } finally {
      await root.cleanup();
    }
  });

  test("a case with no suspendedAt falls back to updatedAt rather than being swept immediately", async () => {
    const root = useSelfHealTestRoot("queue-suspend-fallback");
    try {
      root.writeConfig({ enabled: true, suspendedTimeoutDays: 7 });
      const record = await make("waiting");
      await updateCase(record.id, { status: "suspended" });
      expect(await queue.sweepSuspendedTimeouts()).toEqual([]);
    } finally {
      await root.cleanup();
    }
  });
});
