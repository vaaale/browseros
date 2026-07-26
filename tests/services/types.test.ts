// Service daemon type shapes & defaults (user-specs/002-service-daemons):
//   npx playwright test -c playwright.unit.config.ts tests/services/types.test.ts
import "./_stub-server-only";
import { test, expect } from "@playwright/test";
import {
  DEFAULT_CRASH_RECOVERY_POLICY,
  DEFAULT_SERVICE_TIMEOUTS,
} from "../../src/core/service/types";
import type {
  ServiceManifest,
  ServiceDefinition,
  ServiceState,
  CrashRecoveryPolicy,
  ServiceTimeouts,
  MainToWorkerMessage,
  WorkerToMainMessage,
  RuntimeState,
  ServiceStatusView,
  ServiceRegistryEvent,
} from "../../src/core/service/types";

test.describe("DEFAULT_CRASH_RECOVERY_POLICY", () => {
  test("has the documented defaults", () => {
    expect(DEFAULT_CRASH_RECOVERY_POLICY).toEqual({
      maxRestarts: 5,
      backoffMs: 1000,
      backoffMultiplier: 2,
    });
  });
});

test.describe("DEFAULT_SERVICE_TIMEOUTS", () => {
  test("has the documented defaults", () => {
    expect(DEFAULT_SERVICE_TIMEOUTS).toEqual({
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 30_000,
    });
  });
});

test.describe("ServiceManifest shape", () => {
  test("accepts a minimal manifest", () => {
    const manifest: ServiceManifest = { id: "svc", name: "Svc", version: "1.0.0", entry: "index.js" };
    expect(manifest.id).toBe("svc");
    expect(manifest.dependencies).toBeUndefined();
  });

  test("accepts a fully-populated manifest", () => {
    const manifest: ServiceManifest = {
      id: "svc",
      name: "Svc",
      version: "1.0.0",
      description: "desc",
      entry: "index.js",
      configSchema: { type: "object" },
      dependencies: ["other"],
      settingsRegistration: { label: "Svc", icon: "icon", order: 1, configApp: "custom-app" },
    };
    expect(manifest.dependencies).toEqual(["other"]);
    expect(manifest.settingsRegistration?.label).toBe("Svc");
  });
});

test.describe("ServiceState", () => {
  test("covers every documented state", () => {
    const states: ServiceState[] = ["stopped", "running", "restarting", "crashed", "corrupted"];
    for (const state of states) {
      const def: Partial<ServiceDefinition> = { state };
      expect(def.state).toBe(state);
    }
  });
});

test.describe("CrashRecoveryPolicy / ServiceTimeouts shape", () => {
  test("CrashRecoveryPolicy has the three tunables", () => {
    const policy: CrashRecoveryPolicy = { maxRestarts: 3, backoffMs: 500, backoffMultiplier: 3 };
    expect(policy.maxRestarts).toBe(3);
  });

  test("ServiceTimeouts allows 0 to disable waiting", () => {
    const timeouts: ServiceTimeouts = { startupTimeoutMs: 0, shutdownTimeoutMs: 0 };
    expect(timeouts.startupTimeoutMs).toBe(0);
  });
});

test.describe("Worker IPC protocol", () => {
  test("MainToWorkerMessage covers initialize/dispose/restart", () => {
    const messages: MainToWorkerMessage[] = [
      { type: "initialize", configDirPath: "/c", logsPath: "/l", serviceId: "s" },
      { type: "dispose" },
      { type: "restart", reason: "manual" },
    ];
    expect(messages).toHaveLength(3);
  });

  test("WorkerToMainMessage covers initialized/bound/error/disposed/log/crash", () => {
    const messages: WorkerToMainMessage[] = [
      { type: "initialized" },
      { type: "bound", port: 3000, host: "127.0.0.1" },
      { type: "error", message: "boom", stack: "at x" },
      { type: "disposed" },
      { type: "log", level: "info", message: "hi" },
      { type: "crash", error: "boom", stack: "at x" },
    ];
    expect(messages).toHaveLength(6);
  });
});

test.describe("RuntimeState / ServiceStatusView / ServiceRegistryEvent shape", () => {
  test("RuntimeState carries port + host", () => {
    const state: RuntimeState = { port: 4000, host: "127.0.0.1" };
    expect(state.port).toBe(4000);
  });

  test("ServiceStatusView mirrors the settings UI's needs", () => {
    const view: ServiceStatusView = {
      id: "svc",
      manifest: { id: "svc", name: "Svc", version: "1.0.0", entry: "index.js" },
      state: "running",
      installed: true,
      restartCount: 0,
      boundPort: null,
      boundHost: null,
    };
    expect(view.state).toBe("running");
  });

  test("ServiceRegistryEvent covers every documented event type", () => {
    const events: ServiceRegistryEvent[] = [
      { type: "service:status:changed", id: "s", state: "running" },
      { type: "service:crash", id: "s", error: "boom", restartCount: 1 },
      { type: "service:bound", id: "s", port: 3000, host: "127.0.0.1" },
      { type: "service:installed", id: "s" },
      { type: "service:uninstalled", id: "s" },
    ];
    expect(events).toHaveLength(5);
  });
});
