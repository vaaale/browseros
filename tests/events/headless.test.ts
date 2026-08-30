import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import * as kernel from "../../src/lib/events/kernel";
import * as store from "../../src/lib/events/store";
import * as dispatch from "../../src/lib/events/dispatch";
import { migrateIntegrationsToEvents } from "../../src/lib/events/migrate-integrations";
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

test.describe("headless processing end-to-end (US3)", () => {
  test("register (as a service would) → emit → invoke → ack → processed, through the public API", async () => {
    const { cleanup } = useEventTestRoot("headless-e2e-happy");
    try {
      await kernel.startEventKernel();
      dispatch.setOwnerRunningCheck((ownerId) => ownerId === "svc-x");
      dispatch.setServiceInvoker(async (ownerId, handlerId, record) => {
        // Simulate the worker's own ack over loopback HTTP by calling the
        // public API directly in-process (same effect, no network needed).
        setTimeout(() => {
          kernel.ack(record.id, { handlerId, result: { ok: true }, callerId: ownerId });
        }, 5);
      });

      await kernel.register({
        handlerId: "svc-x-handler",
        eventType: "com.bos.svc-x.thing.happened",
        mode: "headless",
        ownerId: "svc-x",
        displayName: "Svc X Handler",
        enabled: true,
        timeoutMs: 2000,
        declaredBy: "service",
      });

      const emitted = await kernel.emit({
        type: "com.bos.svc-x.thing.happened",
        payload: { summary: "it happened" },
        source: { appId: "svc-x", name: "Svc X" },
      });
      expect(emitted.processing).toBe("pending");

      await waitUntil(() => store.getIndexEntry(emitted.id)?.processing === "processed");
      const full = await kernel.getEventFull(emitted.id);
      expect(full?.processedReason).toBe("all-acked");
      expect(full?.history[0]?.result).toEqual({ ok: true });
    } finally {
      dispatch._resetDispatchForTests();
      await cleanup();
    }
  });

  test("re-registering the same handlerId preserves a previously-disabled state (idempotent upsert)", async () => {
    const { cleanup } = useEventTestRoot("headless-reregister-preserves-enabled");
    try {
      await kernel.startEventKernel();
      await kernel.register({
        handlerId: "svc-y-handler",
        eventType: "com.bos.svc-y.thing.happened",
        mode: "headless",
        ownerId: "svc-y",
        displayName: "Svc Y Handler",
        enabled: true,
        timeoutMs: 2000,
        declaredBy: "service",
      });
      await kernel.setEnabled("svc-y-handler", "svc-y", false);
      expect(store.getHandler("svc-y-handler")?.enabled).toBe(false);

      // Simulate the service restarting and re-declaring the same handler
      // (handler_declare doesn't pass `enabled` — it should NOT re-enable it).
      const api = await import("../../src/lib/events/api");
      await api.register({
        handlerId: "svc-y-handler",
        eventType: "com.bos.svc-y.thing.happened",
        mode: "headless",
        ownerId: "svc-y",
        displayName: "Svc Y Handler",
        timeoutMs: 2000,
        declaredBy: "service",
      });
      expect(store.getHandler("svc-y-handler")?.enabled).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("migrateIntegrationsToEvents is idempotent and uses stable derived ids (R6)", async () => {
    const { cleanup } = useEventTestRoot("headless-migration");
    const integrationsDataDir = join(__dirname, ".tmp", `migration-${process.pid}-${Date.now()}`);
    const previousDataDir = process.env.BOS_DATA_DIR;
    process.env.BOS_DATA_DIR = integrationsDataDir;
    try {
      const integrationsDir = join(integrationsDataDir, "integrations");
      mkdirSync(integrationsDir, { recursive: true });
      writeFileSync(
        join(integrationsDir, "notifications.json"),
        JSON.stringify({
          seq: 2,
          items: [
            {
              id: 2,
              event: { type: "new_email", service: "gsuite/gmail", timestamp: Date.now(), data: { from: "c@d.com", subject: "Yo" } },
              read: true,
            },
            {
              id: 1,
              event: { type: "new_email", service: "gsuite/gmail", timestamp: Date.now(), data: { from: "a@b.com", subject: "Hi" } },
              read: false,
            },
          ],
        }),
      );

      await migrateIntegrationsToEvents();
      expect(store.totalCount()).toBe(2);
      expect(store.getIndexEntry("legacy-1")?.read).toBe("unread");
      expect(store.getIndexEntry("legacy-2")?.read).toBe("read");
      expect(store.getIndexEntry("legacy-1")?.type).toBe("com.bos.gsuite.email.received");

      // Re-run against the same store: the marker file short-circuits, and
      // even without it, appendMigratedEvent's id-already-in-index check
      // would no-op — either way, no duplicates.
      await migrateIntegrationsToEvents();
      expect(store.totalCount()).toBe(2);
    } finally {
      if (previousDataDir === undefined) delete process.env.BOS_DATA_DIR;
      else process.env.BOS_DATA_DIR = previousDataDir;
      rmSync(integrationsDataDir, { recursive: true, force: true });
      await cleanup();
    }
  });
});
