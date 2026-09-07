import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import * as api from "../../src/lib/events/api";
import * as kernel from "../../src/lib/events/kernel";
import { useEventTestRoot } from "./_test-env";

test.describe("event API facade (validation)", () => {
  test("emit rejects an invalid type", async () => {
    const { cleanup } = useEventTestRoot("api-invalid-type");
    try {
      await kernel.startEventKernel();
      await expect(
        api.emit({ type: "not a valid type", payload: {}, source: { appId: "test", name: "Test" } }),
      ).rejects.toMatchObject({ code: "invalid-type" });
    } finally {
      await cleanup();
    }
  });

  test("emit rejects a payload over 1MB (413)", async () => {
    const { cleanup } = useEventTestRoot("api-payload-too-large");
    try {
      await kernel.startEventKernel();
      const big = "x".repeat(1024 * 1024 + 1);
      await expect(
        api.emit({ type: "com.bos.test.big", payload: { big }, source: { appId: "test", name: "Test" } }),
      ).rejects.toMatchObject({ code: "payload-too-large", status: 413 });
    } finally {
      await cleanup();
    }
  });

  test("emit accepts a well-formed request and returns a sequence", async () => {
    const { cleanup } = useEventTestRoot("api-emit-ok");
    try {
      await kernel.startEventKernel();
      const result = await api.emit({ type: "com.bos.test.ok", payload: { summary: "fine" }, source: { appId: "test", name: "Test" } });
      expect(result.sequence).toBe(1);
    } finally {
      await cleanup();
    }
  });

  test("ack is forbidden when the caller does not own the handler (FR-022)", async () => {
    const { cleanup } = useEventTestRoot("api-ack-forbidden");
    try {
      await kernel.startEventKernel();
      await api.register({
        handlerId: "h-owned",
        eventType: "com.bos.owner.thing",
        mode: "headless",
        ownerId: "owner",
        displayName: "H",
      });
      const emitted = await api.emit({ type: "com.bos.owner.thing", payload: {}, source: { appId: "owner", name: "Owner" } });
      expect(() => api.ack(emitted.id, { handlerId: "h-owned", callerId: "impostor" })).toThrow(
        expect.objectContaining({ code: "ack-forbidden" }),
      );
    } finally {
      await cleanup();
    }
  });

  test("register accepts a namespace the owner does not own (037 FR-001)", async () => {
    const { cleanup } = useEventTestRoot("api-namespace-relaxed");
    try {
      await kernel.startEventKernel();
      const reg = await api.register({
        handlerId: "h-cross",
        eventType: "com.bos.someoneelse.thing",
        mode: "headless",
        ownerId: "me",
        displayName: "H",
      });
      expect(reg.handlerId).toBe("h-cross");
      expect(reg.eventType).toBe("com.bos.someoneelse.thing");
      expect(reg.ownerId).toBe("me");
    } finally {
      await cleanup();
    }
  });

  test("register accepts an owned root and a wildcard namespace pattern", async () => {
    const { cleanup } = useEventTestRoot("api-namespace-owned");
    try {
      await kernel.startEventKernel();
      const owned = await api.register({
        handlerId: "h-owned-2",
        eventType: "com.bos.me.thing.happened",
        mode: "headless",
        ownerId: "me",
        displayName: "H",
      });
      expect(owned.handlerId).toBe("h-owned-2");

      const wildcard = await api.register({
        handlerId: "h-owned-3",
        eventType: "com.bos.me.*",
        mode: "headless",
        ownerId: "me",
        displayName: "H",
      });
      expect(wildcard.eventType).toBe("com.bos.me.*");
    } finally {
      await cleanup();
    }
  });

  test("setPreference rejects a handler that is not a UI handler for the type (invalid-preference)", async () => {
    const { cleanup } = useEventTestRoot("api-invalid-preference");
    try {
      await kernel.startEventKernel();
      await api.register({
        handlerId: "h-headless",
        eventType: "com.bos.me.event",
        mode: "headless",
        ownerId: "me",
        displayName: "H",
      });
      await expect(api.setPreference("com.bos.me.event", "h-headless")).rejects.toMatchObject({
        code: "invalid-preference",
      });
    } finally {
      await cleanup();
    }
  });

  test("query filters by type/status/read and reports unreadTotal", async () => {
    const { cleanup } = useEventTestRoot("api-query");
    try {
      await kernel.startEventKernel();
      await api.emit({ type: "com.bos.test.qa", payload: {}, source: { appId: "test", name: "Test" } });
      await api.emit({ type: "com.bos.test.qb", payload: {}, source: { appId: "test", name: "Test" } });
      const result = api.query({ type: "com.bos.test.qa" });
      expect(result.events.length).toBe(1);
      expect(result.events[0].type).toBe("com.bos.test.qa");
      expect(result.unreadTotal).toBe(2);
    } finally {
      await cleanup();
    }
  });
});
