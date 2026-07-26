// ServiceManager: start/stop/restart/startAll lifecycle — real worker_threads
// (fixture entrypoints under _worker-fixtures.ts), real fs under a temp
// BOS_DATA_DIR, no mocking. Crash-recovery paths are covered end-to-end in
// integration.test.ts.
//   npx playwright test -c playwright.unit.config.ts tests/services/ServiceManager.test.ts
import "./_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import net from "node:net";
import type { Worker } from "node:worker_threads";
import { ServiceManager } from "../../src/core/service/ServiceManager";
import { serviceRegistry } from "../../src/core/service/ServiceRegistry";
import type { ServiceManifest } from "../../src/core/service/types";
import { useTestDataDir, resetServiceSingletons } from "./_test-env";
import { RESPONSIVE_WORKER, UNRESPONSIVE_WORKER, installFixtureService } from "./_worker-fixtures";

function manifest(id: string, extra: Partial<ServiceManifest> = {}): ServiceManifest {
  return { id, name: id, version: "1.0.0", entry: "index.js", ...extra };
}

/** Standard per-test setup: a fresh temp dataDir + a clean serviceRegistry()
 *  singleton (ServiceManager's methods reach the registry via the module
 *  singleton internally, not an injected instance, so tests must go through
 *  it too). Returns a `dispose()` to call in a `finally` block. */
function setupTest(label: string) {
  const { dir, cleanup } = useTestDataDir(label);
  resetServiceSingletons();
  const registry = serviceRegistry();
  const manager = new ServiceManager();
  return {
    dir,
    registry,
    manager,
    dispose: () => {
      resetServiceSingletons();
      cleanup();
    },
  };
}

test.describe("getStatus", () => {
  test("returns the registry's current state for an installed service", () => {
    const { registry, manager, dispose } = setupTest("manager-get-status");
    try {
      registry.registerInstalled("svc", manifest("svc"), "/items/svc");
      registry.setState("svc", "running");
      expect(manager.getStatus("svc")).toBe("running");
    } finally {
      dispose();
    }
  });

  test("returns 'stopped' for an unknown service id", () => {
    const { manager, dispose } = setupTest("manager-get-status-unknown");
    try {
      expect(manager.getStatus("does-not-exist")).toBe("stopped");
    } finally {
      dispose();
    }
  });
});

test.describe("start", () => {
  test("validates the manifest before creating a worker — refuses to start when the entrypoint is missing", async () => {
    const { dir, registry, manager, dispose } = setupTest("manager-start-invalid-manifest");
    try {
      // Register the service but never write the entry file on disk.
      mkdirSync(join(dir, "system", "services", "svc"), { recursive: true });
      writeFileSync(join(dir, "system", "services", "svc", "service.json"), JSON.stringify(manifest("svc")));
      registry.registerInstalled("svc", manifest("svc"), "/items/svc");

      await manager.start("svc");

      expect(registry.getService("svc")?.worker).toBeNull();
      expect(registry.getService("svc")?.state).toBe("stopped");
    } finally {
      dispose();
    }
  });

  test("creates a worker with the configured resource limits and reaches 'running'", async () => {
    const { dir, registry, manager, dispose } = setupTest("manager-start-resource-limits");
    try {
      installFixtureService(dir, "svc", { entrySource: RESPONSIVE_WORKER });
      registry.registerInstalled("svc", manifest("svc"), "/items/svc");

      await manager.start("svc", { startupTimeout: 5_000 });

      expect(registry.getService("svc")?.state).toBe("running");
      const worker = registry.getService("svc")?.worker as Worker;
      expect(worker).toBeTruthy();
      expect(worker.resourceLimits?.maxOldGenerationSizeMb).toBe(256);
      expect(worker.resourceLimits?.maxYoungGenerationSizeMb).toBe(64);

      await manager.stop("svc");
    } finally {
      dispose();
    }
  });

  test("sends 'initialize' and waits for 'initialized' before marking the service running", async () => {
    const { dir, registry, manager, dispose } = setupTest("manager-start-sends-initialize");
    try {
      // RESPONSIVE_WORKER only ever reaches "initialized" by receiving and
      // reacting to an "initialize" message — reaching "running" is proof
      // both legs of the handshake happened.
      installFixtureService(dir, "svc", { entrySource: RESPONSIVE_WORKER });
      registry.registerInstalled("svc", manifest("svc"), "/items/svc");

      await manager.start("svc", { startupTimeout: 5_000 });
      expect(registry.getService("svc")?.state).toBe("running");
      expect(registry.getService("svc")?.restartCount).toBe(0);

      await manager.stop("svc");
    } finally {
      dispose();
    }
  });

  test("terminates the worker when it never sends 'initialized' within the startup timeout", async () => {
    const { dir, registry, manager, dispose } = setupTest("manager-start-timeout");
    try {
      installFixtureService(dir, "svc", { entrySource: UNRESPONSIVE_WORKER });
      registry.registerInstalled("svc", manifest("svc"), "/items/svc");

      await manager.start("svc", { startupTimeout: 300 });

      expect(registry.getService("svc")?.state).toBe("stopped");
      expect(registry.getService("svc")?.worker).toBeNull();
    } finally {
      dispose();
    }
  });

  test("detects a port conflict from the service's own config and refuses to start", async () => {
    const { dir, registry, manager, dispose } = setupTest("manager-start-port-conflict");
    const server = net.createServer();
    try {
      installFixtureService(dir, "svc", { entrySource: RESPONSIVE_WORKER });
      registry.registerInstalled("svc", manifest("svc"), "/items/svc");

      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (typeof address === "string" || address === null) throw new Error("expected an AddressInfo");
      const occupiedPort = address.port;

      const configDir = join(dir, "config", "svc");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, "svc.json"), JSON.stringify({ port: occupiedPort, host: "127.0.0.1" }));

      await manager.start("svc");

      expect(registry.getService("svc")?.worker).toBeNull();
      expect(registry.getService("svc")?.state).toBe("stopped");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      dispose();
    }
  });

  test("refuses to start a corrupted service", async () => {
    const { dir, registry, manager, dispose } = setupTest("manager-start-corrupted");
    try {
      installFixtureService(dir, "svc", { entrySource: RESPONSIVE_WORKER });
      registry.registerInstalled("svc", manifest("svc"), "/items/svc");
      registry.markCorrupted("svc", "service.json is missing or invalid");

      await manager.start("svc");

      expect(registry.getService("svc")?.worker).toBeNull();
      expect(registry.getService("svc")?.state).toBe("corrupted");
    } finally {
      dispose();
    }
  });

  test("is a no-op when the service is already running", async () => {
    const { registry, manager, dispose } = setupTest("manager-start-already-running");
    try {
      registry.registerInstalled("svc", manifest("svc"), "/items/svc");
      const fakeWorker = { fake: true } as unknown as Worker;
      registry.setState("svc", "running");
      registry.setWorker("svc", fakeWorker);

      await manager.start("svc");

      // The existing (fake) worker reference must be untouched — no real
      // worker was spawned to replace it.
      expect(registry.getService("svc")?.worker).toBe(fakeWorker);
      expect(registry.getService("svc")?.state).toBe("running");
    } finally {
      dispose();
    }
  });
});

test.describe("stop", () => {
  test("sends 'dispose' and terminates the worker", async () => {
    const { dir, registry, manager, dispose } = setupTest("manager-stop-dispose");
    try {
      installFixtureService(dir, "svc", { entrySource: RESPONSIVE_WORKER });
      registry.registerInstalled("svc", manifest("svc"), "/items/svc");
      await manager.start("svc", { startupTimeout: 5_000 });
      expect(registry.getService("svc")?.state).toBe("running");

      await manager.stop("svc", { shutdownTimeout: 5_000 });

      expect(registry.getService("svc")?.state).toBe("stopped");
      expect(registry.getService("svc")?.worker).toBeNull();
      expect(registry.getService("svc")?.restartCount).toBe(0);
    } finally {
      dispose();
    }
  });

  test("is a no-op (but resets to 'stopped') when there is no worker", async () => {
    const { registry, manager, dispose } = setupTest("manager-stop-no-worker");
    try {
      registry.registerInstalled("svc", manifest("svc"), "/items/svc");
      await expect(manager.stop("svc")).resolves.toBeUndefined();
      expect(registry.getService("svc")?.state).toBe("stopped");
    } finally {
      dispose();
    }
  });

  test("is a no-op for an unknown service id", async () => {
    const { manager, dispose } = setupTest("manager-stop-unknown");
    try {
      await expect(manager.stop("does-not-exist")).resolves.toBeUndefined();
    } finally {
      dispose();
    }
  });
});

test.describe("restart", () => {
  test("stops then starts — ends up running again with a fresh worker", async () => {
    const { dir, registry, manager, dispose } = setupTest("manager-restart");
    try {
      installFixtureService(dir, "svc", { entrySource: RESPONSIVE_WORKER });
      registry.registerInstalled("svc", manifest("svc"), "/items/svc");
      await manager.start("svc", { startupTimeout: 5_000 });
      const firstWorker = registry.getService("svc")?.worker;

      await manager.restart("svc", "manual test restart");

      expect(registry.getService("svc")?.state).toBe("running");
      expect(registry.getService("svc")?.worker).not.toBe(firstWorker);

      await manager.stop("svc");
    } finally {
      dispose();
    }
  });
});

test.describe("startAll", () => {
  test("starts installed services in dependency order", async () => {
    const { dir, registry, manager, dispose } = setupTest("manager-start-all-order");
    try {
      installFixtureService(dir, "base", { entrySource: RESPONSIVE_WORKER });
      installFixtureService(dir, "dependent", { entrySource: RESPONSIVE_WORKER, dependencies: ["base"] });
      registry.registerInstalled("base", manifest("base"), "/items/base");
      registry.registerInstalled("dependent", manifest("dependent", { dependencies: ["base"] }), "/items/dependent");

      await manager.startAll();

      expect(registry.getService("base")?.state).toBe("running");
      expect(registry.getService("dependent")?.state).toBe("running");

      await manager.stop("base");
      await manager.stop("dependent");
    } finally {
      dispose();
    }
  });

  test("skips a dependent service whose dependency never came up (crash-loop prevention)", async () => {
    const { dir, registry, manager, dispose } = setupTest("manager-start-all-skip-dependent");
    try {
      // "base"'s entry is never written — it fails manifest validation and
      // stays "stopped" forever, so "dependent" must be skipped rather than
      // started against a dependency that isn't actually running.
      mkdirSync(join(dir, "system", "services", "base"), { recursive: true });
      writeFileSync(join(dir, "system", "services", "base", "service.json"), JSON.stringify(manifest("base")));
      installFixtureService(dir, "dependent", { entrySource: RESPONSIVE_WORKER, dependencies: ["base"] });

      registry.registerInstalled("base", manifest("base"), "/items/base");
      registry.registerInstalled("dependent", manifest("dependent", { dependencies: ["base"] }), "/items/dependent");

      await manager.startAll();

      expect(registry.getService("base")?.state).toBe("stopped");
      expect(registry.getService("dependent")?.state).toBe("stopped");
      expect(registry.getService("dependent")?.worker).toBeNull();
    } finally {
      dispose();
    }
  });
});
