import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import * as kernel from "../../src/lib/events/kernel";
import * as store from "../../src/lib/events/store";
import * as dispatch from "../../src/lib/events/dispatch";
import { useEventTestRoot } from "./_test-env";

// Performance floor (NFR-001/002/003, SC-006): seeds 100k events directly
// into the warm index (store._seedIndexForTests — no disk I/O, isolating
// the in-memory query/emit cost from fs latency, which atomic-write already
// keeps off the hot path per ADR-4) and asserts the documented budgets.
test.describe("performance floor at 100k events", () => {
  test.setTimeout(60_000);

  test("query() stays under 500ms at 100k events (NFR-002)", async () => {
    const { cleanup } = useEventTestRoot("perf-query");
    try {
      await kernel.startEventKernel();
      store._seedIndexForTests(100_000);
      expect(store.totalCount()).toBe(100_000);

      const start = performance.now();
      const result = kernel.query({ read: "unread", limit: 50 });
      const elapsed = performance.now() - start;

      expect(result.events.length).toBe(50);
      expect(elapsed).toBeLessThan(500);
    } finally {
      await cleanup();
    }
  });

  test("count() (bell) stays fast at 100k events", async () => {
    const { cleanup } = useEventTestRoot("perf-count");
    try {
      await kernel.startEventKernel();
      store._seedIndexForTests(100_000);

      const start = performance.now();
      const counts = kernel.count();
      const elapsed = performance.now() - start;

      expect(counts.grandTotal).toBe(100_000);
      expect(elapsed).toBeLessThan(500);
    } finally {
      await cleanup();
    }
  });

  test("emit() p99 stays under 100ms even with 100k pre-existing events (NFR-001)", async () => {
    const { cleanup } = useEventTestRoot("perf-emit");
    try {
      await kernel.startEventKernel();
      store._seedIndexForTests(100_000);

      const SAMPLE = 50;
      const durations: number[] = [];
      for (let i = 0; i < SAMPLE; i++) {
        const start = performance.now();
        await kernel.emit({ type: "com.bos.perf.emitted", payload: { i }, source: { appId: "perf", name: "Perf" } });
        durations.push(performance.now() - start);
      }
      durations.sort((a, b) => a - b);
      const p99 = durations[Math.floor(durations.length * 0.99)];
      expect(p99).toBeLessThan(100);
    } finally {
      await cleanup();
    }
  });

  test("a headless handler begins processing within 500ms of emission (SC-006)", async () => {
    const { cleanup } = useEventTestRoot("perf-dispatch-begin");
    try {
      await kernel.startEventKernel();
      store._seedIndexForTests(100_000);
      dispatch.setOwnerRunningCheck(() => true);
      let invokedAt = 0;
      dispatch.setServiceInvoker(async () => {
        invokedAt = performance.now();
      });
      await kernel.register({
        handlerId: "perf-handler",
        eventType: "com.bos.perf.dispatch-begin",
        mode: "headless",
        ownerId: "perf",
        displayName: "Perf Handler",
        enabled: true,
        timeoutMs: 5000,
        declaredBy: "service",
      });

      const emitStart = performance.now();
      await kernel.emit({ type: "com.bos.perf.dispatch-begin", payload: {}, source: { appId: "perf", name: "Perf" } });

      await new Promise((resolve) => {
        const start = Date.now();
        const tick = () => {
          if (invokedAt > 0 || Date.now() - start > 5000) return resolve(undefined);
          setTimeout(tick, 2);
        };
        tick();
      });

      expect(invokedAt).toBeGreaterThan(0);
      expect(invokedAt - emitStart).toBeLessThan(500);
    } finally {
      dispatch._resetDispatchForTests();
      await cleanup();
    }
  });
});
