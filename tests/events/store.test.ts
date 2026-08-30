import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { rmSync } from "fs";
import * as store from "../../src/lib/events/store";
import { useEventTestRoot } from "./_test-env";

test.describe("event store", () => {
  test("appendEvent assigns per-type monotonic sequences and durably records the body", async () => {
    const { dir, cleanup } = useEventTestRoot("store-seq");
    try {
      await store.initStore();
      const a1 = await store.appendEvent({ type: "com.bos.test.alpha", payload: { n: 1 }, source: { appId: "test", name: "Test" }, summary: "a1" });
      const a2 = await store.appendEvent({ type: "com.bos.test.alpha", payload: { n: 2 }, source: { appId: "test", name: "Test" }, summary: "a2" });
      const b1 = await store.appendEvent({ type: "com.bos.test.beta", payload: { n: 3 }, source: { appId: "test", name: "Test" }, summary: "b1" });

      expect(a1.sequence).toBe(1);
      expect(a2.sequence).toBe(2);
      expect(b1.sequence).toBe(1); // per-type, independent counter

      const body = await store.getEventBody(a2.id);
      expect(body?.payload).toEqual({ n: 2 });
      expect(store.getIndexEntry(a1.id)?.type).toBe("com.bos.test.alpha");
      expect(store.totalCount()).toBe(3);
    } finally {
      await cleanup();
    }
    void dir;
  });

  test("checkpoint flushes the warm index + month state to disk, and a fresh boot reloads them", async () => {
    const { dir, cleanup } = useEventTestRoot("store-checkpoint");
    try {
      await store.initStore();
      const ev = await store.appendEvent({ type: "com.bos.test.gamma", payload: { x: true }, source: { appId: "test", name: "Test" }, summary: "g1" });
      store.updateEventState(ev.id, (s) => {
        s.read = "read";
      });
      await store.checkpoint();

      // Simulate a restart against the SAME root.
      store.setStoreRoot(dir);
      await store.initStore();

      const entry = store.getIndexEntry(ev.id);
      expect(entry?.read).toBe("read");
      expect(entry?.sequence).toBe(1);
      const body = await store.getEventBody(ev.id);
      expect(body?.payload).toEqual({ x: true });
    } finally {
      await cleanup();
    }
  });

  test("boot repair rebuilds the index from shards when index.json is missing", async () => {
    const { dir, cleanup } = useEventTestRoot("store-repair");
    try {
      await store.initStore();
      const ev1 = await store.appendEvent({ type: "com.bos.test.delta", payload: { a: 1 }, source: { appId: "test", name: "Test" }, summary: "d1" });
      const ev2 = await store.appendEvent({ type: "com.bos.test.delta", payload: { a: 2 }, source: { appId: "test", name: "Test" }, summary: "d2" });
      await store.checkpoint();

      // Delete index.json to force a shard rescan on the next boot.
      rmSync(`${dir}/index.json`, { force: true });
      store.setStoreRoot(dir);
      await store.initStore();

      const all = store.listAll();
      expect(all.map((e) => e.id).sort()).toEqual([ev1.id, ev2.id].sort());
      // Sequence numbering must be recovered correctly from the shard scan so a
      // subsequent emit doesn't collide with a previously-assigned sequence.
      const ev3 = await store.appendEvent({ type: "com.bos.test.delta", payload: { a: 3 }, source: { appId: "test", name: "Test" }, summary: "d3" });
      expect(ev3.sequence).toBe(3);
    } finally {
      await cleanup();
    }
  });

  test("handler registry and preferences persist across a re-init", async () => {
    const { dir, cleanup } = useEventTestRoot("store-handlers");
    try {
      await store.initStore();
      await store.putHandler({
        handlerId: "h1",
        eventType: "com.bos.test.alpha",
        mode: "headless",
        ownerId: "test",
        displayName: "H1",
        enabled: true,
        timeoutMs: 30_000,
        declaredBy: "service",
      });
      await store.setPreference("com.bos.test.alpha", "pref-1");

      store.setStoreRoot(dir);
      await store.initStore();

      expect(store.getHandler("h1")?.displayName).toBe("H1");
      expect(store.getPreference("com.bos.test.alpha")?.preferredHandlerId).toBe("pref-1");
    } finally {
      await cleanup();
    }
  });
});
