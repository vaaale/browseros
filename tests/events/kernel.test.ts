import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import * as kernel from "../../src/lib/events/kernel";
import * as store from "../../src/lib/events/store";
import { useEventTestRoot } from "./_test-env";

test.describe("event kernel", () => {
  test("emit with no active handlers is immediately processed (R8)", async () => {
    const { cleanup } = useEventTestRoot("kernel-no-handlers");
    try {
      await kernel.startEventKernel();
      const result = await kernel.emit({
        type: "com.bos.test.lonely",
        payload: { summary: "no handlers" },
        source: { appId: "test", name: "Test" },
      });
      expect(result.processing).toBe("processed");
      expect(result.activeHandlers).toBe(0);
      expect(result.read).toBe("unread");

      const full = await kernel.getEventFull(result.id);
      expect(full?.processedReason).toBe("no-active-handlers");
    } finally {
      await cleanup();
    }
  });

  test("query / count / markRead / markAllRead — the two-axis state machine", async () => {
    const { cleanup } = useEventTestRoot("kernel-state-machine");
    try {
      await kernel.startEventKernel();
      const e1 = await kernel.emit({ type: "com.bos.test.one", payload: { summary: "e1" }, source: { appId: "test", name: "Test" } });
      const e2 = await kernel.emit({ type: "com.bos.test.one", payload: { summary: "e2" }, source: { appId: "test", name: "Test" } });

      expect(kernel.count().unreadTotal).toBe(2);

      const markResult = kernel.markRead(e1.id);
      expect(markResult.read).toBe("read");
      expect(markResult.unreadTotal).toBe(1);

      const unread = kernel.query({ read: "unread" });
      expect(unread.events.map((e) => e.id)).toEqual([e2.id]);

      const historical = kernel.query({ read: "read" });
      expect(historical.events.map((e) => e.id)).toEqual([e1.id]);

      const all = kernel.markAllRead();
      expect(all.marked).toBe(1);
      expect(all.unreadTotal).toBe(0);
      expect(kernel.count().unreadTotal).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("emit rejects nothing itself (validation lives in api.ts) but sequence + ts are recorded", async () => {
    const { cleanup } = useEventTestRoot("kernel-emit-basic");
    try {
      await kernel.startEventKernel();
      const result = await kernel.emit({ type: "com.bos.test.two", payload: {}, source: { appId: "test", name: "Test" } });
      expect(result.sequence).toBe(1);
      expect(typeof result.ts).toBe("number");
    } finally {
      await cleanup();
    }
  });

  test("register / unregister a UI handler and set/clear a preference", async () => {
    const { cleanup } = useEventTestRoot("kernel-ui-handlers");
    try {
      await kernel.startEventKernel();
      await kernel.register({
        handlerId: "ui-1",
        eventType: "com.bos.test.three",
        mode: "ui",
        ownerId: "test",
        displayName: "UI One",
        enabled: true,
        timeoutMs: 30_000,
        declaredBy: "manifest",
        launch: { appId: "test" },
      });

      const pref = await kernel.setPreference("com.bos.test.three", "ui-1");
      expect(pref?.preferredHandlerId).toBe("ui-1");
      expect(kernel.getPreference("com.bos.test.three")?.preferredHandlerId).toBe("ui-1");

      await kernel.setPreference("com.bos.test.three", null);
      expect(kernel.getPreference("com.bos.test.three")).toBeUndefined();

      await kernel.unregister("ui-1", "test");
      expect(store.getHandler("ui-1")).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  test("unregister rejects a non-owner", async () => {
    const { cleanup } = useEventTestRoot("kernel-unregister-owner");
    try {
      await kernel.startEventKernel();
      await kernel.register({
        handlerId: "ui-2",
        eventType: "com.bos.test.four",
        mode: "ui",
        ownerId: "owner-a",
        displayName: "UI Two",
        enabled: true,
        timeoutMs: 30_000,
        declaredBy: "manifest",
      });
      await expect(kernel.unregister("ui-2", "owner-b")).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });
});
