// CrashRecovery pure helpers: computeBackoffMs / shouldRestart / cancelPendingRestart.
// handleCrash()'s full lifecycle (crash → backoff → restart → max restarts) is
// exercised end-to-end in integration.test.ts, since it reaches into the
// serviceRegistry()/serviceManager() singletons and a real worker.
//   npx playwright test -c playwright.unit.config.ts tests/services/CrashRecovery.test.ts
import "./_stub-server-only";
import { test, expect } from "@playwright/test";
import {
  computeBackoffMs,
  shouldRestart,
  cancelPendingRestart,
  handleCrash,
} from "../../src/core/service/CrashRecovery";
import { serviceRegistry } from "../../src/core/service/ServiceRegistry";
import { DEFAULT_CRASH_RECOVERY_POLICY } from "../../src/core/service/types";
import { useTestDataDir, resetServiceSingletons } from "./_test-env";

test.describe("computeBackoffMs", () => {
  test("restartCount=1 returns the base backoff (1000ms)", () => {
    expect(computeBackoffMs(1, DEFAULT_CRASH_RECOVERY_POLICY)).toBe(1000);
  });

  test("restartCount=3 returns backoffMs * multiplier^(n-1) (4000ms)", () => {
    expect(computeBackoffMs(3, DEFAULT_CRASH_RECOVERY_POLICY)).toBe(4000);
  });

  test("follows the documented 1s/2s/4s/8s/16s progression for restarts 1-5", () => {
    const values = [1, 2, 3, 4, 5].map((n) => computeBackoffMs(n, DEFAULT_CRASH_RECOVERY_POLICY));
    expect(values).toEqual([1000, 2000, 4000, 8000, 16000]);
  });

  test("clamps a restartCount of 0 (or negative) to the base backoff", () => {
    expect(computeBackoffMs(0, DEFAULT_CRASH_RECOVERY_POLICY)).toBe(1000);
    expect(computeBackoffMs(-5, DEFAULT_CRASH_RECOVERY_POLICY)).toBe(1000);
  });

  test("honors a custom policy", () => {
    const policy = { maxRestarts: 3, backoffMs: 500, backoffMultiplier: 3 };
    expect(computeBackoffMs(2, policy)).toBe(1500);
  });
});

test.describe("shouldRestart", () => {
  test("returns true when restartCount is below maxRestarts", () => {
    expect(shouldRestart(1, DEFAULT_CRASH_RECOVERY_POLICY)).toBe(true);
    expect(shouldRestart(4, DEFAULT_CRASH_RECOVERY_POLICY)).toBe(true);
  });

  test("returns true when restartCount equals maxRestarts (inclusive boundary)", () => {
    expect(shouldRestart(5, DEFAULT_CRASH_RECOVERY_POLICY)).toBe(true);
  });

  test("returns false once restartCount exceeds maxRestarts", () => {
    expect(shouldRestart(6, DEFAULT_CRASH_RECOVERY_POLICY)).toBe(false);
  });
});

test.describe("cancelPendingRestart", () => {
  test("is a no-op when nothing is pending for that service id", () => {
    expect(() => cancelPendingRestart("never-had-a-pending-restart")).not.toThrow();
  });

  test("cancels a pending restart's timeout when one is scheduled", async () => {
    // handleCrash() is the only thing that actually schedules a pending
    // restart. Use a huge backoff so the timer would never fire on its own
    // within the test, then cancel it and confirm handleCrash's awaited
    // promise settles immediately instead of waiting out the backoff.
    const { cleanup } = useTestDataDir("crash-recovery-cancel");
    resetServiceSingletons();
    try {
      const registry = serviceRegistry();
      registry.registerInstalled("svc-cancel", { id: "svc-cancel", name: "svc-cancel", version: "1.0.0", entry: "index.js" }, "/items/svc-cancel");

      const start = Date.now();
      const crashPromise = handleCrash("svc-cancel", "boom", undefined, {
        maxRestarts: 5,
        backoffMs: 60_000,
        backoffMultiplier: 2,
      });
      cancelPendingRestart("svc-cancel");
      await crashPromise;
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(5_000); // resolved on cancel, not after the 60s backoff
      // Cancelling returns early before start() is called again — state stays "restarting".
      expect(registry.getService("svc-cancel")?.state).toBe("restarting");
    } finally {
      resetServiceSingletons();
      cleanup();
    }
  });
});
