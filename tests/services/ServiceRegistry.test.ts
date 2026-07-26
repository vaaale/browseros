// ServiceRegistry: discovery, installed/source split, event log & subscribe.
// Each test uses its own `new ServiceRegistry()` instance (the class is
// exported directly) rather than the globalThis singleton, so tests never
// leak state into one another — no reset dance needed here.
//   npx playwright test -c playwright.unit.config.ts tests/services/ServiceRegistry.test.ts
import "./_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync, symlinkSync } from "fs";
import { ServiceRegistry } from "../../src/core/service/ServiceRegistry";
import type { ServiceManifest, ServiceRegistryEvent } from "../../src/core/service/types";
import { useTestDataDir } from "./_test-env";

function manifestJson(id: string, extra: Partial<ServiceManifest> = {}): string {
  return JSON.stringify({ id, name: id, version: "1.0.0", entry: "index.js", ...extra });
}

/** Lays out dataDir()/user-apps/<id>/services/service.json and, when
 *  `install` is true, an dataDir()/system/services/<id> symlink pointing at
 *  it — mirroring the real item-to-system symlink mapping. */
function createSourceItem(dataDir: string, id: string, opts: { install?: boolean; manifestOverride?: string } = {}): void {
  const itemDir = join(dataDir, "user-apps", id);
  const servicesDir = join(itemDir, "services");
  mkdirSync(servicesDir, { recursive: true });
  writeFileSync(join(servicesDir, "service.json"), opts.manifestOverride ?? manifestJson(id));
  writeFileSync(join(servicesDir, "index.js"), "module.exports = {};");

  if (opts.install) {
    const systemServicesRoot = join(dataDir, "system", "services");
    mkdirSync(systemServicesRoot, { recursive: true });
    symlinkSync(servicesDir, join(systemServicesRoot, id), "dir");
  }
}

test.describe("initialize / discoverServices", () => {
  test("discovers services from user-apps", async () => {
    const { dir, cleanup } = useTestDataDir("registry-discover-user-apps");
    try {
      createSourceItem(dir, "svc-a");
      const registry = new ServiceRegistry();
      await registry.initialize();
      expect(registry.getSourceServices().map((s) => s.id)).toEqual(["svc-a"]);
    } finally {
      cleanup();
    }
  });

  test("discovers services from marketplace/<mktId>/items/<id>", async () => {
    const { dir, cleanup } = useTestDataDir("registry-discover-marketplace");
    try {
      const itemDir = join(dir, "marketplace", "some-marketplace", "items", "svc-b");
      const servicesDir = join(itemDir, "services");
      mkdirSync(servicesDir, { recursive: true });
      writeFileSync(join(servicesDir, "service.json"), manifestJson("svc-b"));
      writeFileSync(join(servicesDir, "index.js"), "module.exports = {};");

      const registry = new ServiceRegistry();
      await registry.initialize();
      expect(registry.getSourceServices().map((s) => s.id)).toEqual(["svc-b"]);
    } finally {
      cleanup();
    }
  });

  test("is idempotent — a second initialize() does not re-run the scan", async () => {
    const { dir, cleanup } = useTestDataDir("registry-initialize-idempotent");
    try {
      createSourceItem(dir, "svc-a");
      const registry = new ServiceRegistry();
      await registry.initialize();
      createSourceItem(dir, "svc-c"); // added after first initialize()
      await registry.initialize(); // should be a no-op
      expect(registry.getSourceServices().map((s) => s.id)).toEqual(["svc-a"]);
    } finally {
      cleanup();
    }
  });
});

test.describe("getSourceServices / getAllServices / getService", () => {
  test("getSourceServices excludes items with an active install symlink", async () => {
    const { dir, cleanup } = useTestDataDir("registry-source-vs-installed");
    try {
      createSourceItem(dir, "svc-source-only");
      createSourceItem(dir, "svc-installed", { install: true });
      const registry = new ServiceRegistry();
      await registry.discoverServices();
      expect(registry.getSourceServices().map((s) => s.id)).toEqual(["svc-source-only"]);
    } finally {
      cleanup();
    }
  });

  test("getAllServices returns both installed (full runtime state) and source-only entries", async () => {
    const { dir, cleanup } = useTestDataDir("registry-get-all");
    try {
      createSourceItem(dir, "svc-source-only");
      createSourceItem(dir, "svc-installed", { install: true });
      const registry = new ServiceRegistry();
      await registry.discoverServices();

      const all = registry.getAllServices();
      const byId = Object.fromEntries(all.map((d) => [d.id, d]));
      expect(byId["svc-installed"].installed).toBe(true);
      expect(byId["svc-installed"].state).toBe("stopped");
      expect(byId["svc-source-only"].installed).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("getService returns the definition for an installed service, undefined otherwise", async () => {
    const { dir, cleanup } = useTestDataDir("registry-get-service");
    try {
      createSourceItem(dir, "svc-installed", { install: true });
      const registry = new ServiceRegistry();
      await registry.discoverServices();
      expect(registry.getService("svc-installed")?.id).toBe("svc-installed");
      expect(registry.getService("does-not-exist")).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("marks an installed service corrupted when its service.json is missing/invalid", async () => {
    const { dir, cleanup } = useTestDataDir("registry-corrupted-on-discover");
    try {
      const systemServicesRoot = join(dir, "system", "services", "svc-broken");
      mkdirSync(systemServicesRoot, { recursive: true });
      writeFileSync(join(systemServicesRoot, "service.json"), "{ not valid json");
      const registry = new ServiceRegistry();
      await registry.discoverServices();
      expect(registry.getService("svc-broken")?.state).toBe("corrupted");
      expect(registry.getService("svc-broken")?.corruptedReason).toBeTruthy();
    } finally {
      cleanup();
    }
  });
});

test.describe("registerInstalled / unregisterInstalled", () => {
  test("registerInstalled adds a stopped, uninstalled-runtime-state entry", () => {
    const registry = new ServiceRegistry();
    registry.registerInstalled("svc-x", { id: "svc-x", name: "svc-x", version: "1.0.0", entry: "index.js" }, "/items/svc-x");
    const def = registry.getService("svc-x");
    expect(def?.installed).toBe(true);
    expect(def?.state).toBe("stopped");
    expect(def?.itemPath).toBe("/items/svc-x");
  });

  test("registerInstalled preserves live runtime state (state/worker/restartCount) on refresh", () => {
    const registry = new ServiceRegistry();
    const manifest: ServiceManifest = { id: "svc-x", name: "svc-x", version: "1.0.0", entry: "index.js" };
    registry.registerInstalled("svc-x", manifest, "/items/svc-x");
    registry.setState("svc-x", "running");
    registry.incrementRestart("svc-x");

    registry.registerInstalled("svc-x", manifest, "/items/svc-x");
    expect(registry.getService("svc-x")?.state).toBe("running");
    expect(registry.getService("svc-x")?.restartCount).toBe(1);
  });

  test("unregisterInstalled removes the service from the registry", () => {
    const registry = new ServiceRegistry();
    registry.registerInstalled("svc-x", { id: "svc-x", name: "svc-x", version: "1.0.0", entry: "index.js" }, "/items/svc-x");
    registry.unregisterInstalled("svc-x");
    expect(registry.getService("svc-x")).toBeUndefined();
  });
});

test.describe("setState / setWorker / setBound / incrementRestart / resetRestart / markCorrupted", () => {
  function registryWithService(): ServiceRegistry {
    const registry = new ServiceRegistry();
    registry.registerInstalled("svc-x", { id: "svc-x", name: "svc-x", version: "1.0.0", entry: "index.js" }, "/items/svc-x");
    return registry;
  }

  test("setState updates state and emits a service:status:changed event", () => {
    const registry = registryWithService();
    const events: ServiceRegistryEvent[] = [];
    registry.on((e) => events.push(e));
    registry.setState("svc-x", "running");
    expect(registry.getService("svc-x")?.state).toBe("running");
    expect(events).toContainEqual({ type: "service:status:changed", id: "svc-x", state: "running" });
  });

  test("setWorker updates the worker reference without emitting an event", () => {
    const registry = registryWithService();
    const events: ServiceRegistryEvent[] = [];
    registry.on((e) => events.push(e));
    const fakeWorker = { fake: true } as unknown as import("node:worker_threads").Worker;
    registry.setWorker("svc-x", fakeWorker);
    expect(registry.getService("svc-x")?.worker).toBe(fakeWorker);
    expect(events).toEqual([]);
  });

  test("setBound updates boundPort/boundHost and emits a service:bound event", () => {
    const registry = registryWithService();
    const events: ServiceRegistryEvent[] = [];
    registry.on((e) => events.push(e));
    registry.setBound("svc-x", 4000, "127.0.0.1");
    expect(registry.getService("svc-x")?.boundPort).toBe(4000);
    expect(registry.getService("svc-x")?.boundHost).toBe("127.0.0.1");
    expect(events).toContainEqual({ type: "service:bound", id: "svc-x", port: 4000, host: "127.0.0.1" });
  });

  test("incrementRestart increments and returns the running count", () => {
    const registry = registryWithService();
    expect(registry.incrementRestart("svc-x")).toBe(1);
    expect(registry.incrementRestart("svc-x")).toBe(2);
    expect(registry.getService("svc-x")?.restartCount).toBe(2);
  });

  test("resetRestart resets the count to 0", () => {
    const registry = registryWithService();
    registry.incrementRestart("svc-x");
    registry.incrementRestart("svc-x");
    registry.resetRestart("svc-x");
    expect(registry.getService("svc-x")?.restartCount).toBe(0);
  });

  test("markCorrupted sets state=corrupted with a reason and emits an event", () => {
    const registry = registryWithService();
    const events: ServiceRegistryEvent[] = [];
    registry.on((e) => events.push(e));
    registry.markCorrupted("svc-x", "service.json is missing");
    expect(registry.getService("svc-x")?.state).toBe("corrupted");
    expect(registry.getService("svc-x")?.corruptedReason).toBe("service.json is missing");
    expect(events).toContainEqual({ type: "service:status:changed", id: "svc-x", state: "corrupted" });
  });

  test("setters on an unknown id are silent no-ops", () => {
    const registry = new ServiceRegistry();
    expect(() => registry.setState("nope", "running")).not.toThrow();
    expect(() => registry.setWorker("nope", null)).not.toThrow();
    expect(() => registry.setBound("nope", 1, "h")).not.toThrow();
    expect(registry.incrementRestart("nope")).toBe(0);
    expect(() => registry.resetRestart("nope")).not.toThrow();
    expect(() => registry.markCorrupted("nope", "x")).not.toThrow();
  });
});

test.describe("subscribe — replay + tail", () => {
  test("subscribe(0, ...) replays every past event, then tails new ones live", () => {
    const registry = new ServiceRegistry();
    registry.registerInstalled("svc-x", { id: "svc-x", name: "svc-x", version: "1.0.0", entry: "index.js" }, "/items/svc-x");
    registry.setState("svc-x", "running"); // seq 1, happens before subscribe

    const received: Array<{ event: ServiceRegistryEvent; seq: number }> = [];
    const unsubscribe = registry.subscribe(0, (event, seq) => received.push({ event, seq }));

    registry.setState("svc-x", "stopped"); // seq 2, live
    unsubscribe();
    registry.setState("svc-x", "running"); // after unsubscribe — must not be received

    expect(received).toHaveLength(2);
    expect(received[0].event).toEqual({ type: "service:status:changed", id: "svc-x", state: "running" });
    expect(received[1].event).toEqual({ type: "service:status:changed", id: "svc-x", state: "stopped" });
  });

  test("subscribe(since, ...) only replays events after the given seq", () => {
    const registry = new ServiceRegistry();
    registry.registerInstalled("svc-x", { id: "svc-x", name: "svc-x", version: "1.0.0", entry: "index.js" }, "/items/svc-x");
    registry.setState("svc-x", "running"); // seq 1
    registry.setState("svc-x", "stopped"); // seq 2

    const received: ServiceRegistryEvent[] = [];
    registry.subscribe(1, (event) => received.push(event));
    expect(received).toEqual([{ type: "service:status:changed", id: "svc-x", state: "stopped" }]);
  });

  test("multiple listeners all receive the same event; a throwing listener does not break the others", () => {
    const registry = new ServiceRegistry();
    registry.registerInstalled("svc-x", { id: "svc-x", name: "svc-x", version: "1.0.0", entry: "index.js" }, "/items/svc-x");

    const receivedA: ServiceRegistryEvent[] = [];
    const receivedB: ServiceRegistryEvent[] = [];
    registry.on(() => {
      throw new Error("broken listener");
    });
    registry.on((e) => receivedA.push(e));
    registry.on((e) => receivedB.push(e));

    expect(() => registry.setState("svc-x", "running")).not.toThrow();
    expect(receivedA).toHaveLength(1);
    expect(receivedB).toHaveLength(1);
  });

  test("off() unsubscribes a listener registered via on()", () => {
    const registry = new ServiceRegistry();
    registry.registerInstalled("svc-x", { id: "svc-x", name: "svc-x", version: "1.0.0", entry: "index.js" }, "/items/svc-x");
    const received: ServiceRegistryEvent[] = [];
    const listener = (e: ServiceRegistryEvent) => received.push(e);
    registry.on(listener);
    registry.off(listener);
    registry.setState("svc-x", "running");
    expect(received).toEqual([]);
  });
});
