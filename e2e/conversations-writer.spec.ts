import { test, expect } from "@playwright/test";
import { enqueuePerKey } from "../src/lib/agent/write-queue";
import { isStaleSnapshot } from "../src/lib/agent/conversations-sanitize";

// Task 3.2 — single-writer conversation persistence. All conversation-file
// writers funnel through a per-key (per-conversation) queue so read-modify-write
// cycles are serialized critical sections; different conversations stay
// concurrent. Browser-less pure-module spec (no page fixture).
test.use({ video: "off" });

test.describe("write-queue", () => {
  test("writes to the same key are serialized in order", async () => {
    const order: number[] = [];
    const slow = enqueuePerKey("a", async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push(1);
    });
    const fast = enqueuePerKey("a", async () => {
      order.push(2);
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual([1, 2]);
  });

  test("different keys run concurrently", async () => {
    let aDone = false;
    const a = enqueuePerKey("a", async () => {
      await new Promise((r) => setTimeout(r, 50));
      aDone = true;
    });
    const b = enqueuePerKey("b", async () => {
      expect(aDone).toBe(false);
    });
    await Promise.all([a, b]);
  });

  test("a failed task does not poison the chain — later tasks still run", async () => {
    const failing = enqueuePerKey("a", async () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");
    const after = await enqueuePerKey("a", async () => "ran");
    expect(after).toBe("ran");
  });

  test("returns the task's resolved value", async () => {
    const v = await enqueuePerKey("a", async () => 42);
    expect(v).toBe(42);
  });

  test("drained keys are cleaned up (no unbounded map growth)", async () => {
    const { pendingKeyCount } = await import("../src/lib/agent/write-queue");
    await enqueuePerKey("cleanup-1", async () => {});
    await enqueuePerKey("cleanup-2", async () => {});
    // Allow the finally-cleanup microtask to run.
    await new Promise((r) => setTimeout(r, 10));
    expect(pendingKeyCount()).toBe(0);
  });
});

const msg = (id: string) => ({ id, role: "user", content: id });

test.describe("stale-write guard (isStaleSnapshot)", () => {
  test("a strict prefix-regression is stale", () => {
    const existing = [msg("a"), msg("b"), msg("c")];
    expect(isStaleSnapshot([msg("a"), msg("b")], existing)).toBe(true);
  });

  test("same length or longer is never stale", () => {
    const existing = [msg("a"), msg("b")];
    expect(isStaleSnapshot([msg("a"), msg("b")], existing)).toBe(false);
    expect(isStaleSnapshot([msg("a"), msg("b"), msg("c")], existing)).toBe(false);
  });

  test("a shortened history with a NEW tail id (regenerate) is not stale", () => {
    const existing = [msg("a"), msg("b"), msg("c")];
    expect(isStaleSnapshot([msg("a"), msg("b2-regenerated")], existing)).toBe(false);
  });

  test("messages without ids are never judged stale", () => {
    const existing = [msg("a"), msg("b"), msg("c")];
    expect(isStaleSnapshot([msg("a"), { role: "user", content: "no id" }], existing)).toBe(false);
  });

  test("empty incoming is not stale (handled by the empty-snapshot guard instead)", () => {
    expect(isStaleSnapshot([], [msg("a")])).toBe(false);
  });
});
