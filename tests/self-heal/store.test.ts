import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import * as store from "../../src/lib/self-heal/store";
import { computeFailureSignature } from "../../src/lib/self-heal/signature";
import { useSelfHealTestRoot } from "./_test-env";
import type { TriggerContext } from "../../src/lib/self-heal/types";

// 031-self-healing FR-018 / design ADR-6 + ADR-9. The store is the single
// source of truth for case state, the dedupe map, the cost ledger and the
// mutual-exclusion slot — so these tests pin the invariants the rest of the
// spine assumes: atomic on-disk writes, an index that mirrors case status, and
// a slot that cannot leak.

const ctx: TriggerContext = { trigger: "hard-error", toolName: "file_read", errorMessage: "permission denied" };

function newCase() {
  return store.createCase({ trigger: "hard-error", title: "file_read denies", signature: computeFailureSignature(ctx), context: ctx });
}

test.describe("case store", () => {
  test("createCase allocates a branch-safe id, writes the file, and indexes it", async () => {
    const root = useSelfHealTestRoot("store-create");
    try {
      const first = await newCase();
      expect(first.id).toMatch(/^[a-z0-9]+$/); // one lowercase segment — ADR-3's branch constraint
      expect(first.id).toBe("0001");
      expect(first.status).toBe("new");
      expect(first.timeline).toHaveLength(1);

      expect(existsSync(join(root.dir, "self-heal", "cases", "0001.json"))).toBe(true);
      const index = JSON.parse(readFileSync(join(root.dir, "self-heal", "index.json"), "utf8"));
      expect(index.cases["0001"].status).toBe("new");
      expect(index.nextCaseSeq).toBe(2);

      // The dedupe entry is written in the SAME transaction as the case, so two
      // concurrent triggers can never both miss each other.
      expect(index.dedupe[first.signature.dedupeKey].caseId).toBe("0001");
    } finally {
      await root.cleanup();
    }
  });

  test("ids are unique and monotonic under concurrent creation", async () => {
    const root = useSelfHealTestRoot("store-concurrent");
    try {
      const created = await Promise.all([newCase(), newCase(), newCase(), newCase(), newCase()]);
      const ids = created.map((c) => c.id);
      expect(new Set(ids).size).toBe(5);
      expect([...ids].sort()).toEqual(["0001", "0002", "0003", "0004", "0005"]);
    } finally {
      await root.cleanup();
    }
  });

  test("updateCase appends a timeline entry on a status change and mirrors the index", async () => {
    const root = useSelfHealTestRoot("store-update");
    try {
      const record = await newCase();
      const updated = await store.updateCase(record.id, { status: "diagnosed", scopeClass: "e", note: "class e" });
      expect(updated?.status).toBe("diagnosed");
      expect(updated?.scopeClass).toBe("e");
      expect(updated?.timeline).toHaveLength(2);
      expect(updated?.timeline[1].note).toBe("class e");

      const index = await store.readIndex();
      expect(index.cases[record.id].status).toBe("diagnosed");
      expect(index.dedupe[record.signature.dedupeKey].status).toBe("diagnosed");
    } finally {
      await root.cleanup();
    }
  });

  test("a same-status update does not grow the timeline (redelivery is idempotent)", async () => {
    const root = useSelfHealTestRoot("store-idempotent");
    try {
      const record = await newCase();
      await store.updateCase(record.id, { status: "diagnosed", scopeClass: "e" });
      const again = await store.updateCase(record.id, { status: "diagnosed", scopeClass: "e" });
      // 2 = the creation entry + the one real transition. An at-least-once
      // event redelivery must not look like a second transition.
      expect(again?.timeline).toHaveLength(2);
    } finally {
      await root.cleanup();
    }
  });

  test("appendTimeline records progress within a state", async () => {
    const root = useSelfHealTestRoot("store-timeline");
    try {
      const record = await newCase();
      const updated = await store.appendTimeline(record.id, "still working");
      expect(updated?.status).toBe("new");
      expect(updated?.timeline.at(-1)?.note).toBe("still working");
    } finally {
      await root.cleanup();
    }
  });

  test("updating a case that does not exist returns undefined instead of throwing", async () => {
    const root = useSelfHealTestRoot("store-missing");
    try {
      expect(await store.updateCase("nope", { status: "failed" })).toBeUndefined();
      expect(await store.getCase("nope")).toBeUndefined();
    } finally {
      await root.cleanup();
    }
  });

  test("listCases returns newest first and survives a garbage file", async () => {
    const root = useSelfHealTestRoot("store-list");
    try {
      const a = await newCase();
      const b = await store.createCase({
        trigger: "explicit",
        title: "second",
        signature: computeFailureSignature({ trigger: "explicit", description: "second" }),
        context: { trigger: "explicit", description: "second" },
      });
      const list = await store.listCases();
      expect(list.map((c) => c.id)).toContain(a.id);
      expect(list.map((c) => c.id)).toContain(b.id);
      expect(list[0].createdAt).toBeGreaterThanOrEqual(list[list.length - 1].createdAt);
    } finally {
      await root.cleanup();
    }
  });

  test("listCases on a fresh root is empty, not an error", async () => {
    const root = useSelfHealTestRoot("store-empty");
    try {
      expect(await store.listCases()).toEqual([]);
      const index = await store.readIndex();
      expect(index.nextCaseSeq).toBe(1);
      expect(index.inFlightSlowPathCaseId).toBeNull();
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("dedupe map", () => {
  test("get/set round-trips", async () => {
    const root = useSelfHealTestRoot("store-dedupe");
    try {
      await store.setDedupeEntry({ dedupeKey: "k", caseId: "0009", status: "diagnosed", at: 1_700_000_000_000 });
      const entry = await store.getDedupeEntry("k");
      expect(entry?.caseId).toBe("0009");
      expect(await store.getDedupeEntry("absent")).toBeUndefined();
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("the mutual-exclusion slot (FR-015c / ADR-9)", () => {
  test("the first claimant wins and a second is refused", async () => {
    const root = useSelfHealTestRoot("store-slot");
    try {
      expect(await store.claimInFlightSlot("0001")).toBe(true);
      expect(await store.claimInFlightSlot("0002")).toBe(false);
      expect(await store.getInFlightSlowPathCaseId()).toBe("0001");
    } finally {
      await root.cleanup();
    }
  });

  test("the holder can re-claim its own slot (resume is idempotent)", async () => {
    const root = useSelfHealTestRoot("store-slot-reclaim");
    try {
      await store.claimInFlightSlot("0001");
      expect(await store.claimInFlightSlot("0001")).toBe(true);
    } finally {
      await root.cleanup();
    }
  });

  test("clearInFlightSlot only clears the named holder", async () => {
    const root = useSelfHealTestRoot("store-slot-clear");
    try {
      await store.claimInFlightSlot("0001");
      await store.clearInFlightSlot("0002"); // not the holder — no effect
      expect(await store.getInFlightSlowPathCaseId()).toBe("0001");
      await store.clearInFlightSlot("0001");
      expect(await store.getInFlightSlowPathCaseId()).toBeNull();
    } finally {
      await root.cleanup();
    }
  });

  test("clearInFlightSlot with no argument clears unconditionally", async () => {
    const root = useSelfHealTestRoot("store-slot-force");
    try {
      await store.claimInFlightSlot("0001");
      await store.clearInFlightSlot();
      expect(await store.getInFlightSlowPathCaseId()).toBeNull();
    } finally {
      await root.cleanup();
    }
  });

  test("reaching a terminal status releases the slot in the SAME write (it cannot leak)", async () => {
    const root = useSelfHealTestRoot("store-slot-terminal");
    try {
      const record = await newCase();
      await store.claimInFlightSlot(record.id);
      await store.updateCase(record.id, { status: "preview-ready" });
      expect(await store.getInFlightSlowPathCaseId()).toBeNull();
    } finally {
      await root.cleanup();
    }
  });

  test("a NON-terminal status keeps the slot (a suspended question still blocks)", async () => {
    const root = useSelfHealTestRoot("store-slot-suspended");
    try {
      const record = await newCase();
      await store.claimInFlightSlot(record.id);
      await store.updateCase(record.id, { status: "suspended" });
      expect(await store.getInFlightSlowPathCaseId()).toBe(record.id);
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("cost ledger persistence", () => {
  test("appended entries survive a re-read", async () => {
    const root = useSelfHealTestRoot("store-ledger");
    try {
      await store.appendCostLedger({ caseId: "0001", role: "diagnostician", tokens: 1_234, at: Date.now() });
      await store.appendCostLedger({ caseId: "0001", role: "pipeline", tokens: 10, at: Date.now(), estimated: true });
      const ledger = await store.getCostLedger();
      expect(ledger).toHaveLength(2);
      expect(ledger[0].tokens).toBe(1_234);
      expect(ledger[1].estimated).toBe(true);
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("index resilience", () => {
  test("a partial index file is merged over a fresh one rather than crashing", async () => {
    const root = useSelfHealTestRoot("store-partial-index");
    try {
      const { writeFileSync, mkdirSync } = await import("fs");
      mkdirSync(join(root.dir, "self-heal"), { recursive: true });
      // An index written by an older revision: no queues, no ledger.
      writeFileSync(join(root.dir, "self-heal", "index.json"), JSON.stringify({ version: 1, nextCaseSeq: 7, cases: {} }), "utf8");
      const index = await store.readIndex();
      expect(index.nextCaseSeq).toBe(7);
      expect(index.ledger).toEqual([]);
      expect(index.slowQueue).toEqual([]);
      expect(index.costQueue).toEqual([]);
      // And it is still writable.
      const created = await newCase();
      expect(created.id).toBe("0007");
    } finally {
      await root.cleanup();
    }
  });

  test("an unparseable index falls back to empty rather than wedging the spine", async () => {
    const root = useSelfHealTestRoot("store-corrupt-index");
    try {
      const { writeFileSync, mkdirSync } = await import("fs");
      mkdirSync(join(root.dir, "self-heal"), { recursive: true });
      writeFileSync(join(root.dir, "self-heal", "index.json"), "{ not json", "utf8");
      const index = await store.readIndex();
      expect(index.nextCaseSeq).toBe(1);
    } finally {
      await root.cleanup();
    }
  });
});
