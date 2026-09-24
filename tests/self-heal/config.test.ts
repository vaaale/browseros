import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import {
  flattenSelfHealConfig,
  patchSelfHealConfig,
  readSelfHealConfig,
  shapeSelfHealConfig,
  triggerEnabled,
  SELF_HEAL_CONFIG_KEYS,
} from "../../src/lib/self-heal/config";
import { SELF_HEAL_DEFAULTS, TRIGGER_TYPES } from "../../src/lib/self-heal/types";
import { useSelfHealTestRoot } from "./_test-env";

// 031-self-healing FR-006/FR-027.
//
// The namespace is stored FLAT (`triggers.hardError`, …) because /api/config's
// PATCH coerces against a flat `fields` list and silently drops anything
// undeclared — so this module is the only place that maps between that storage
// and the nested config the spine reads. Two properties matter: every declared
// key round-trips (or a Settings toggle is a no-op on save), and every number is
// clamped (or a hand-edited file can wedge the spine).

test.describe("defaults", () => {
  test("a fresh install is conservative: only the explicit trigger is on (US5)", () => {
    const cfg = shapeSelfHealConfig({});
    expect(cfg.enabled).toBe(true);
    expect(cfg.triggers.explicit).toBe(true);
    expect(cfg.triggers["hard-error"]).toBe(false);
    expect(cfg.triggers["repeated-failure"]).toBe(false);
    expect(cfg.triggers["workflow-timeout"]).toBe(false);
    expect(cfg.triggers["log-events"]).toBe(false);
  });

  test("the documented numeric defaults", () => {
    const cfg = shapeSelfHealConfig({});
    expect(cfg.costCapPerDay).toBe(1_000_000);
    expect(cfg.dedupeWindowSec).toBe(86_400);
    expect(cfg.explicitDedupeWindowSec).toBe(3_600);
    expect(cfg.suspendedTimeoutDays).toBe(7);
    expect(cfg.costQueueMax).toBe(100);
    expect(cfg.costQueueTtlDays).toBe(7);
    expect(cfg.tdd.targetCoverage).toBe(95);
    expect(cfg.diagnostician.idleThresholdSec).toBe(300);
    expect(cfg.repeatedFailure).toEqual({ count: 3, windowSec: 300 });
    // FR-002 (amended): a single failure fires by default.
    expect(cfg.hardError).toEqual({ minCount: 1 });
  });
});

test.describe("round-tripping", () => {
  test("flatten → shape is the identity on the defaults", () => {
    expect(shapeSelfHealConfig(flattenSelfHealConfig(SELF_HEAL_DEFAULTS))).toEqual(SELF_HEAL_DEFAULTS);
  });

  test("every declared config key round-trips (a Settings toggle is never a no-op)", () => {
    const flat = flattenSelfHealConfig(SELF_HEAL_DEFAULTS);
    for (const key of SELF_HEAL_CONFIG_KEYS) {
      expect(Object.hasOwn(flat, key), `${key} is declared but never persisted`).toBe(true);
    }
    // And nothing is persisted that the registration doesn't declare — an
    // undeclared key would be silently dropped by /api/config's coercion.
    for (const key of Object.keys(flat)) {
      expect((SELF_HEAL_CONFIG_KEYS as readonly string[]).includes(key), `${key} is persisted but not declared`).toBe(true);
    }
  });

  test("a non-default value survives the round trip", () => {
    const custom = {
      ...SELF_HEAL_DEFAULTS,
      enabled: false,
      triggers: { ...SELF_HEAL_DEFAULTS.triggers, "hard-error": true, "log-events": true },
      tdd: { required: false, targetCoverage: 80 },
      repeatedFailure: { count: 5, windowSec: 900 },
    };
    expect(shapeSelfHealConfig(flattenSelfHealConfig(custom))).toEqual(custom);
  });
});

test.describe("coercion and clamping", () => {
  test("string booleans from a hand-edited file are accepted", () => {
    const cfg = shapeSelfHealConfig({ enabled: "false", "triggers.hardError": "true" });
    expect(cfg.enabled).toBe(false);
    expect(cfg.triggers["hard-error"]).toBe(true);
  });

  test("garbage falls back to the default rather than to undefined", () => {
    const cfg = shapeSelfHealConfig({ enabled: "maybe", costCapPerDay: "lots", "tdd.targetCoverage": null });
    expect(cfg.enabled).toBe(true);
    expect(cfg.costCapPerDay).toBe(1_000_000);
    expect(cfg.tdd.targetCoverage).toBe(95);
  });

  test("numbers are clamped into their documented ranges", () => {
    const low = shapeSelfHealConfig({
      "diagnostician.idleThresholdSec": 0,
      "tdd.targetCoverage": -50,
      suspendedTimeoutDays: 0,
      costQueueMax: 0,
      costQueueTtlDays: 0,
      "repeatedFailure.count": 1,
      "repeatedFailure.windowSec": 1,
      "hardError.minCount": 0,
    });
    expect(low.diagnostician.idleThresholdSec).toBe(30);
    expect(low.tdd.targetCoverage).toBe(0);
    expect(low.suspendedTimeoutDays).toBe(1);
    expect(low.costQueueMax).toBe(1);
    expect(low.costQueueTtlDays).toBe(1);
    expect(low.repeatedFailure.count).toBe(2);
    expect(low.repeatedFailure.windowSec).toBe(10);
    expect(low.hardError.minCount).toBe(1);

    const high = shapeSelfHealConfig({
      "tdd.targetCoverage": 500,
      dedupeWindowSec: 99_999_999,
      costQueueMax: 999_999,
      "hardError.minCount": 500,
    });
    expect(high.tdd.targetCoverage).toBe(100);
    expect(high.dedupeWindowSec).toBe(30 * 86_400);
    expect(high.costQueueMax).toBe(10_000);
    expect(high.hardError.minCount).toBe(100);
  });

  test("a numeric string is accepted and rounded", () => {
    expect(shapeSelfHealConfig({ "tdd.targetCoverage": "90.4" }).tdd.targetCoverage).toBe(90);
  });
});

test.describe("triggerEnabled (FR-006)", () => {
  test("the global switch wins over every per-trigger toggle", () => {
    const cfg = shapeSelfHealConfig({
      enabled: false,
      "triggers.explicit": true,
      "triggers.hardError": true,
      "triggers.repeatedFailure": true,
      "triggers.workflowTimeout": true,
      "triggers.logEvents": true,
    });
    for (const t of TRIGGER_TYPES) expect(triggerEnabled(cfg, t)).toBe(false);
  });

  test("each trigger is independently toggleable", () => {
    const cfg = shapeSelfHealConfig({ enabled: true, "triggers.hardError": true });
    expect(triggerEnabled(cfg, "hard-error")).toBe(true);
    expect(triggerEnabled(cfg, "explicit")).toBe(true); // on by default
    expect(triggerEnabled(cfg, "repeated-failure")).toBe(false);
    expect(triggerEnabled(cfg, "log-events")).toBe(false);
  });
});

test.describe("persistence", () => {
  test("readSelfHealConfig reflects a patch immediately (the kill switch is not cached)", async () => {
    const root = useSelfHealTestRoot("config-persist");
    try {
      expect((await readSelfHealConfig()).enabled).toBe(true);
      await patchSelfHealConfig({ enabled: false });
      // SC-006 depends on this: the switch must take effect on the very next
      // trigger, so the config is resolved per call and never memoized.
      expect((await readSelfHealConfig()).enabled).toBe(false);
      await patchSelfHealConfig({ "triggers.hardError": true });
      const cfg = await readSelfHealConfig();
      expect(cfg.enabled).toBe(false);
      expect(cfg.triggers["hard-error"]).toBe(true);
    } finally {
      await root.cleanup();
    }
  });

  test("an absent namespace file reads as the defaults, not as blanks", async () => {
    const root = useSelfHealTestRoot("config-absent");
    try {
      expect(await readSelfHealConfig()).toEqual(SELF_HEAL_DEFAULTS);
    } finally {
      await root.cleanup();
    }
  });
});
