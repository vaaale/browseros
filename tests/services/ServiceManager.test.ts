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
import { ServiceManager, serviceManager } from "../../src/core/service/ServiceManager";
import { serviceRegistry } from "../../src/core/service/ServiceRegistry";
import { cancelPendingRestart } from "../../src/core/service/CrashRecovery";
import { serviceToolBridge } from "../../src/lib/agent/service-tool-bridge";
import { uninstallService } from "../../src/system/marketplace/install/serviceInstaller";
import type { ServiceManifest } from "../../src/core/service/types";
import { useTestDataDir, resetServiceSingletons } from "./_test-env";
import { RESPONSIVE_WORKER, UNRESPONSIVE_WORKER, installFixtureService, installBrokenFixtureService } from "./_worker-fixtures";
import { installToolFixtureService, ECHO_TOOL_NAME } from "./_tool-service-fixtures";

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

// 039-service-tool-exposure — declares "echo_tool" right after "initialized"
// (mirrors TOOL_DECLARING_WORKER), but self-exits ~50ms later ONCE (tracked via
// a marker file in its config dir) to simulate an unexpected crash. On a
// subsequent start (after the marker exists) it behaves like a normal
// tool-declaring, dispose-handling worker — letting the same test drive a
// clean stop() afterward.
const TOOL_DECLARE_THEN_SELF_EXIT_ONCE = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("fs");
const path = require("path");
if (parentPort) {
  const markerPath = path.join(workerData.configDirPath, ".crashed-once");
  parentPort.on("message", (msg) => {
    if (!msg) return;
    if (msg.type === "initialize") {
      parentPort.postMessage({ type: "initialized" });
      parentPort.postMessage({
        type: "tool_declare",
        payload: {
          callId: "declare-echo_tool",
          declaration: {
            name: "echo_tool",
            description: "Echoes the given text back",
            inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          },
        },
      });
      if (!fs.existsSync(markerPath)) {
        fs.writeFileSync(markerPath, "1");
        setTimeout(() => process.exit(1), 50);
      }
    }
    if (msg.type === "dispose") {
      parentPort.postMessage({ type: "disposed" });
    }
  });
}
`;

function manifest(id: string, extra: Partial<ServiceManifest> = {}): ServiceManifest {
  return { id, name: id, version: "1.0.0", entry: "index.js", ...extra };
}

/** Standard per-test setup: a fresh temp dataDir + a clean serviceRegistry()
 *  singleton (ServiceManager's methods reach the registry via the module
 *  singleton internally, not an injected instance, so tests must go through
 *  it too). Returns a `dispose()` to call in a `finally` block. */
function setupTest(label: string) {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- useTestDataDir is a test helper (temp-dir setup), not a React hook
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
      installBrokenFixtureService(dir, "svc", manifest("svc"));
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

      // Config is BOS-owned state under system/config/<id>/ (035 FR-004), not
      // data/config/<id> and not inside the item.
      const configDir = join(dir, "system", "config", "svc");
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
      installBrokenFixtureService(dir, "base", manifest("base"));
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

// 039-service-tool-exposure (T024/US2) — every lifecycle path that ends a
// service's worker must remove its tools from the bridge (FR-006), so no
// stale call to a stopped/crashed/uninstalled service is ever possible.
test.describe("service-tool lifecycle cleanup (039-service-tool-exposure)", () => {
  test("stop() unregisters the service's tools", async () => {
    const { dir, registry, manager, dispose } = setupTest("manager-stop-unregisters-tools");
    try {
      installToolFixtureService(dir, "svc");
      registry.registerInstalled("svc", manifest("svc", { deploymentMode: "tools" }), "/items/svc");
      await manager.start("svc", { startupTimeout: 5_000 });
      await waitFor(() => serviceToolBridge().registry.has(`svc:${ECHO_TOOL_NAME}`));
      expect(serviceToolBridge().serviceToolsFor("svc")).toHaveLength(1);

      await manager.stop("svc", { shutdownTimeout: 5_000 });

      expect(serviceToolBridge().serviceToolsFor("svc")).toHaveLength(0);
      expect(serviceToolBridge().registry.has(`svc:${ECHO_TOOL_NAME}`)).toBe(false);
    } finally {
      dispose();
    }
  });

  test("stop() is a no-op cleanup-wise when the service never registered any tools", async () => {
    const { dir, registry, manager, dispose } = setupTest("manager-stop-no-tools");
    try {
      installFixtureService(dir, "svc", { entrySource: RESPONSIVE_WORKER });
      registry.registerInstalled("svc", manifest("svc"), "/items/svc");
      await manager.start("svc", { startupTimeout: 5_000 });

      await expect(manager.stop("svc", { shutdownTimeout: 5_000 })).resolves.toBeUndefined();
      expect(serviceToolBridge().serviceToolsFor("svc")).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  test("an unexpected worker exit (crash) unregisters tools; a subsequent start re-declares and re-registers them", async () => {
    // Two real worker-thread start/stop cycles under CI/host contention can
    // comfortably exceed Playwright's default 30s per-test timeout.
    test.setTimeout(90_000);
    const { dir, registry, manager, dispose } = setupTest("manager-crash-unregisters-tools");
    try {
      mkdirSync(join(dir, "system", "config", "svc"), { recursive: true });
      installFixtureService(dir, "svc", { entrySource: TOOL_DECLARE_THEN_SELF_EXIT_ONCE, deploymentMode: "tools" });
      registry.registerInstalled("svc", manifest("svc", { deploymentMode: "tools" }), "/items/svc");

      await manager.start("svc", { startupTimeout: 30_000 });
      await waitFor(() => serviceToolBridge().registry.has("svc:echo_tool"), 30_000);

      // The fixture worker self-exits ~50ms after declaring — an unexpected
      // exit that CH-001/handleCrash must treat as a crash, unregistering its
      // tools (FR-006) rather than leaving a stale entry pointing at a dead worker.
      await waitFor(() => !serviceToolBridge().registry.has("svc:echo_tool"), 30_000);
      expect(registry.getService("svc")?.restartCount).toBeGreaterThan(0);

      // Drive the restart ourselves rather than waiting out crash-recovery's
      // own backoff timer — cancel its pending auto-restart first so our
      // start() isn't rejected by the "already restarting" guard.
      cancelPendingRestart("svc");
      registry.setState("svc", "stopped");
      await manager.start("svc", { startupTimeout: 30_000 });

      // Second run sees the crash marker and behaves like a normal
      // tool-declaring, dispose-handling worker — proving the tool
      // re-registers once the restarted worker re-declares it.
      await waitFor(() => serviceToolBridge().registry.has("svc:echo_tool"), 30_000);
      expect(serviceToolBridge().serviceToolsFor("svc")).toHaveLength(1);

      await manager.stop("svc", { shutdownTimeout: 30_000 });
    } finally {
      dispose();
    }
  });

  test("service:uninstalled (via serviceInstaller.uninstallService) unregisters tools", async () => {
    const { dir, dispose } = setupTest("manager-uninstall-unregisters-tools");
    try {
      installToolFixtureService(dir, "svc");
      const registry = serviceRegistry();
      registry.registerInstalled("svc", manifest("svc", { deploymentMode: "tools" }), "/items/svc");
      // Use the module singleton, not `new ServiceManager()` — uninstallService
      // reaches ServiceManager through `serviceManager()` internally, and a
      // worker's lifecycle listeners are bound to whichever instance started
      // it, so starting through the same singleton keeps the stop path (called
      // by uninstallService) from misreading the exit as an unexpected crash.
      const manager = serviceManager();
      await manager.start("svc", { startupTimeout: 5_000 });
      await waitFor(() => serviceToolBridge().registry.has(`svc:${ECHO_TOOL_NAME}`));

      await uninstallService("svc");

      expect(serviceToolBridge().serviceToolsFor("svc")).toHaveLength(0);
      expect(serviceToolBridge().registry.has(`svc:${ECHO_TOOL_NAME}`)).toBe(false);
      expect(registry.getService("svc")).toBeUndefined();
    } finally {
      dispose();
    }
  });

  test("uninstalling an already-stopped service (that still has stale tool entries) removes them too", async () => {
    const { dir, dispose } = setupTest("manager-uninstall-already-stopped");
    try {
      installToolFixtureService(dir, "svc");
      const registry = serviceRegistry();
      registry.registerInstalled("svc", manifest("svc", { deploymentMode: "tools" }), "/items/svc");
      // Register a tool directly against the bridge without a running worker,
      // simulating a stale entry that survived from a previous run — belt-
      // and-suspenders coverage for serviceInstaller's own defensive cleanup
      // call (independent of ServiceManager.stop()).
      serviceToolBridge().registerTool("svc", {
        name: "stale_tool",
        description: "a stale tool entry",
        inputSchema: { type: "object" },
      });
      expect(serviceToolBridge().serviceToolsFor("svc")).toHaveLength(1);

      await uninstallService("svc");

      expect(serviceToolBridge().serviceToolsFor("svc")).toHaveLength(0);
    } finally {
      dispose();
    }
  });
});
