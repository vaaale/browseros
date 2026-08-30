import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import * as kernel from "../../src/lib/events/kernel";
import * as store from "../../src/lib/events/store";
import * as dispatch from "../../src/lib/events/dispatch";
import { useEventTestRoot } from "./_test-env";

function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitUntil timed out"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

test.describe("dispatch engine", () => {
  // NOTE: useEventTestRoot() resets the dispatch module's singleton state
  // (including the backoff schedule) — _setBackoffScheduleForTests() must be
  // called AFTER useEventTestRoot() in every test, never in a beforeEach that
  // runs before it.

  test("fan-out: a headless handler is invoked and acking transitions the event to processed", async () => {
    const { cleanup } = useEventTestRoot("dispatch-fanout");
    try {
      await kernel.startEventKernel();
      dispatch.setOwnerRunningCheck(() => true);
      let invoked: { eventId: string; handlerId: string } | null = null;
      dispatch.setServiceInvoker(async (ownerId, handlerId, record) => {
        invoked = { eventId: record.id, handlerId };
        // Simulate the worker acking asynchronously via the public API.
        setTimeout(() => dispatch.settleAck(record.id, handlerId, { ok: true }, ownerId), 5);
      });

      await kernel.register({
        handlerId: "h1",
        eventType: "com.bos.test.fanout",
        mode: "headless",
        ownerId: "svc-a",
        displayName: "H1",
        enabled: true,
        timeoutMs: 2000,
        declaredBy: "service",
      });

      const emitted = await kernel.emit({ type: "com.bos.test.fanout", payload: {}, source: { appId: "svc-a", name: "Svc A" } });
      expect(emitted.processing).toBe("pending");
      expect(emitted.activeHandlers).toBe(1);

      await waitUntil(() => store.getIndexEntry(emitted.id)?.processing === "processed");
      expect(invoked).toEqual({ eventId: emitted.id, handlerId: "h1" });
      const full = await kernel.getEventFull(emitted.id);
      expect(full?.processedReason).toBe("all-acked");
      expect(full?.history[0]?.status).toBe("acked");
      expect(full?.history[0]?.result).toEqual({ ok: true });
    } finally {
      dispatch._resetDispatchForTests();
      await cleanup();
    }
  });

  test("three handlers fan out concurrently (not sequentially) for the same event", async () => {
    const { cleanup } = useEventTestRoot("dispatch-concurrent");
    try {
      await kernel.startEventKernel();
      dispatch.setOwnerRunningCheck(() => true);
      const invokedAt: number[] = [];
      dispatch.setServiceInvoker(async (ownerId, handlerId, record) => {
        invokedAt.push(Date.now());
        setTimeout(() => dispatch.settleAck(record.id, handlerId, undefined, ownerId), 20);
      });
      for (const id of ["h1", "h2", "h3"]) {
        await kernel.register({
          handlerId: id,
          eventType: "com.bos.test.concurrent",
          mode: "headless",
          ownerId: "svc-a",
          displayName: id,
          enabled: true,
          timeoutMs: 2000,
          declaredBy: "service",
        });
      }
      const emitted = await kernel.emit({ type: "com.bos.test.concurrent", payload: {}, source: { appId: "svc-a", name: "Svc A" } });
      await waitUntil(() => store.getIndexEntry(emitted.id)?.processing === "processed");
      expect(invokedAt.length).toBe(3);
      // All three should have started within a few ms of each other (concurrent),
      // not staggered by tens of ms (sequential).
      expect(Math.max(...invokedAt) - Math.min(...invokedAt)).toBeLessThan(20);
    } finally {
      dispatch._resetDispatchForTests();
      await cleanup();
    }
  });

  test("per-handler FIFO: two events for the same handler are processed in emission order", async () => {
    const { cleanup } = useEventTestRoot("dispatch-fifo");
    try {
      await kernel.startEventKernel();
      dispatch.setOwnerRunningCheck(() => true);
      const order: string[] = [];
      dispatch.setServiceInvoker(async (ownerId, handlerId, record) => {
        order.push(record.id);
        // First event finishes slower than the second would if run concurrently,
        // proving strict per-handler sequencing rather than accidental ordering.
        const delay = order.length === 1 ? 30 : 5;
        setTimeout(() => dispatch.settleAck(record.id, handlerId, undefined, ownerId), delay);
      });
      await kernel.register({
        handlerId: "h-fifo",
        eventType: "com.bos.test.fifo",
        mode: "headless",
        ownerId: "svc-a",
        displayName: "H",
        enabled: true,
        timeoutMs: 2000,
        declaredBy: "service",
      });
      const e1 = await kernel.emit({ type: "com.bos.test.fifo", payload: {}, source: { appId: "svc-a", name: "Svc A" } });
      const e2 = await kernel.emit({ type: "com.bos.test.fifo", payload: {}, source: { appId: "svc-a", name: "Svc A" } });
      await waitUntil(() => store.getIndexEntry(e2.id)?.processing === "processed");
      expect(order).toEqual([e1.id, e2.id]);
    } finally {
      dispatch._resetDispatchForTests();
      await cleanup();
    }
  });

  test("retry then permanent failure — non-blocking, other handlers still complete", async () => {
    const { cleanup } = useEventTestRoot("dispatch-retry");
    try {
      dispatch._setBackoffScheduleForTests([5, 5, 5]); // real 1s/5s/30s would make this impractically slow
      await kernel.startEventKernel();
      dispatch.setOwnerRunningCheck(() => true);
      let failingAttempts = 0;
      dispatch.setServiceInvoker(async (ownerId, handlerId, record) => {
        if (handlerId === "failing") {
          failingAttempts++;
          // Never acks — invokeAndWait will time out (short timeoutMs below).
          return;
        }
        setTimeout(() => dispatch.settleAck(record.id, handlerId, undefined, ownerId), 5);
      });
      await kernel.register({
        handlerId: "failing",
        eventType: "com.bos.test.retry",
        mode: "headless",
        ownerId: "svc-a",
        displayName: "Failing",
        enabled: true,
        timeoutMs: 20,
        declaredBy: "service",
      });
      await kernel.register({
        handlerId: "healthy",
        eventType: "com.bos.test.retry",
        mode: "headless",
        ownerId: "svc-a",
        displayName: "Healthy",
        enabled: true,
        timeoutMs: 2000,
        declaredBy: "service",
      });

      const emitted = await kernel.emit({ type: "com.bos.test.retry", payload: {}, source: { appId: "svc-a", name: "Svc A" } });
      await waitUntil(() => store.getIndexEntry(emitted.id)?.processing === "processed", 5000);

      expect(failingAttempts).toBe(3); // 3 attempts total (FR-007)
      const full = await kernel.getEventFull(emitted.id);
      expect(full?.processedReason).toBe("all-settled-with-failures");
      const failingHistory = full?.history.filter((h) => h.handlerId === "failing") ?? [];
      expect(failingHistory.at(-1)?.status).toBe("permanently_failed");
      const healthyHistory = full?.history.filter((h) => h.handlerId === "healthy") ?? [];
      expect(healthyHistory.at(-1)?.status).toBe("acked");
    } finally {
      dispatch._resetDispatchForTests();
      await cleanup();
    }
  });

  test("exactly-once-settle: a late ack after a handler already acked is a no-op duplicate", async () => {
    const { cleanup } = useEventTestRoot("dispatch-exactly-once");
    try {
      await kernel.startEventKernel();
      dispatch.setOwnerRunningCheck(() => true);
      dispatch.setServiceInvoker(async (ownerId, handlerId, record) => {
        setTimeout(() => dispatch.settleAck(record.id, handlerId, { first: true }, ownerId), 5);
      });
      await kernel.register({
        handlerId: "h-once",
        eventType: "com.bos.test.once",
        mode: "headless",
        ownerId: "svc-a",
        displayName: "H",
        enabled: true,
        timeoutMs: 2000,
        declaredBy: "service",
      });
      const emitted = await kernel.emit({ type: "com.bos.test.once", payload: {}, source: { appId: "svc-a", name: "Svc A" } });
      await waitUntil(() => store.getIndexEntry(emitted.id)?.processing === "processed");

      const outcome = dispatch.settleAck(emitted.id, "h-once", { second: true }, "svc-a");
      expect(outcome.kind).toBe("duplicate");
      const full = await kernel.getEventFull(emitted.id);
      expect(full?.history.filter((h) => h.status === "acked").length).toBe(1);
      expect(full?.history[0]?.result).toEqual({ first: true });
    } finally {
      dispatch._resetDispatchForTests();
      await cleanup();
    }
  });

  test("offline/disabled handler is not active and does not block completion", async () => {
    const { cleanup } = useEventTestRoot("dispatch-not-active");
    try {
      await kernel.startEventKernel();
      dispatch.setOwnerRunningCheck((ownerId) => ownerId === "svc-online");
      dispatch.setServiceInvoker(async (ownerId, handlerId, record) => {
        setTimeout(() => dispatch.settleAck(record.id, handlerId, undefined, ownerId), 5);
      });
      await kernel.register({
        handlerId: "h-offline",
        eventType: "com.bos.test.offline",
        mode: "headless",
        ownerId: "svc-offline",
        displayName: "Offline",
        enabled: true,
        timeoutMs: 2000,
        declaredBy: "service",
      });
      await kernel.register({
        handlerId: "h-disabled",
        eventType: "com.bos.test.offline",
        mode: "headless",
        ownerId: "svc-online",
        displayName: "Disabled",
        enabled: false,
        timeoutMs: 2000,
        declaredBy: "service",
      });

      // Neither handler is active (one offline, one disabled) — the event
      // must be immediately processed on emit (R8), not stuck pending.
      const emitted = await kernel.emit({ type: "com.bos.test.offline", payload: {}, source: { appId: "svc-online", name: "Svc" } });
      expect(emitted.processing).toBe("processed");
      expect(emitted.activeHandlers).toBe(0);
    } finally {
      dispatch._resetDispatchForTests();
      await cleanup();
    }
  });

  test("at-least-once re-dispatch on boot: an un-acked pending event is redelivered", async () => {
    const { dir, cleanup } = useEventTestRoot("dispatch-boot-redispatch");
    try {
      await kernel.startEventKernel();
      dispatch.setOwnerRunningCheck(() => true);
      dispatch.setServiceInvoker(async () => {
        // Never acks — simulates a crash mid-dispatch.
      });
      await kernel.register({
        handlerId: "h-crash",
        eventType: "com.bos.test.crash",
        mode: "headless",
        ownerId: "svc-a",
        displayName: "H",
        enabled: true,
        timeoutMs: 60_000, // long enough that it never times out during this test
        declaredBy: "service",
      });
      const emitted = await kernel.emit({ type: "com.bos.test.crash", payload: {}, source: { appId: "svc-a", name: "Svc A" } });
      expect(emitted.processing).toBe("pending");
      await store.checkpoint();

      // Simulate a restart: fresh in-memory state, same on-disk root.
      dispatch._resetDispatchForTests();
      store.setStoreRoot(dir);
      const kernelModule = await import("../../src/lib/events/kernel");
      kernelModule._resetKernelForTests();
      dispatch.setOwnerRunningCheck(() => true);

      let redelivered = false;
      dispatch.setServiceInvoker(async (ownerId, handlerId, record) => {
        redelivered = true;
        setTimeout(() => dispatch.settleAck(record.id, handlerId, undefined, ownerId), 5);
      });
      await kernelModule.startEventKernel();
      await waitUntil(() => redelivered);
      await waitUntil(() => store.getIndexEntry(emitted.id)?.processing === "processed");
    } finally {
      dispatch._resetDispatchForTests();
      await cleanup();
    }
  });

  test("late handler registration catches up a still-pending event (FR-005b)", async () => {
    const { cleanup } = useEventTestRoot("dispatch-late-registration");
    try {
      await kernel.startEventKernel();
      dispatch.setOwnerRunningCheck(() => true);
      // handler A never acks — the long timeout ensures it's still "pending"
      // for the whole test, keeping the event pending throughout.
      dispatch.setServiceInvoker(async () => {});
      await kernel.register({
        handlerId: "h-a",
        eventType: "com.bos.test.late",
        mode: "headless",
        ownerId: "svc-a",
        displayName: "A",
        enabled: true,
        timeoutMs: 60_000,
        declaredBy: "service",
      });

      const emitted = await kernel.emit({ type: "com.bos.test.late", payload: {}, source: { appId: "svc-a", name: "Svc A" } });
      expect(emitted.processing).toBe("pending");

      // Handler B registers LATE (after the event was already emitted+dispatched
      // to A). It must still receive this pending event (at-least-once catch-up).
      let bInvoked = false;
      dispatch.setServiceInvoker(async (ownerId, handlerId, record) => {
        if (handlerId === "h-b") {
          bInvoked = true;
          setTimeout(() => dispatch.settleAck(record.id, handlerId, undefined, ownerId), 5);
        }
      });
      await kernel.register({
        handlerId: "h-b",
        eventType: "com.bos.test.late",
        mode: "headless",
        ownerId: "svc-b",
        displayName: "B",
        enabled: true,
        timeoutMs: 2000,
        declaredBy: "service",
      });

      await waitUntil(() => bInvoked);
      // Still pending overall — A (never acks) is still an active, unsettled handler.
      expect(store.getIndexEntry(emitted.id)?.processing).toBe("pending");
    } finally {
      dispatch._resetDispatchForTests();
      await cleanup();
    }
  });
});
