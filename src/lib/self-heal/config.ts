import "server-only";
import { readNamespace, patchNamespace } from "@/lib/config/store";
import { SELF_HEAL_DEFAULTS, TRIGGER_TYPES, type SelfHealConfig, type TriggerType } from "./types";

// The `selfHeal` configuration namespace (031-self-healing FR-027).
//
// Persisted flat (`triggers.hardError`, `tdd.targetCoverage`, …) because the
// generic /api/config PATCH coerces incoming values against a FLAT `fields`
// list and silently drops anything undeclared — the same trap documented on the
// `build-studio` registration in config/registry.ts. This module is the single
// place that maps between that flat storage and the nested SelfHealConfig the
// spine reads, so neither side has to know about the other's shape.

/** Flat storage keys, in the order the Settings tab groups them. */
export const SELF_HEAL_CONFIG_KEYS = [
  "enabled",
  "triggers.explicit",
  "triggers.hardError",
  "triggers.repeatedFailure",
  "triggers.workflowTimeout",
  "triggers.logEvents",
  "diagnostician.scheduled",
  "diagnostician.idleThresholdSec",
  "autonomousImplement",
  "tdd.required",
  "tdd.targetCoverage",
  "costCapPerDay",
  "dedupeWindowSec",
  "explicitDedupeWindowSec",
  "suspendedTimeoutDays",
  "costQueueMax",
  "costQueueTtlDays",
  "repeatedFailure.count",
  "repeatedFailure.windowSec",
  "hardError.minCount",
  "stuckDetector.enabled",
  "stuckDetector.repeatCalls",
] as const;

/** Flat key ↔ TriggerType. The flat side is camelCase (config-field
 *  convention); the type side is the kebab-case trigger id used in events and
 *  the case record. */
const TRIGGER_KEYS: Record<TriggerType, string> = {
  explicit: "triggers.explicit",
  "hard-error": "triggers.hardError",
  "repeated-failure": "triggers.repeatedFailure",
  "workflow-timeout": "triggers.workflowTimeout",
  "log-events": "triggers.logEvents",
};

function bool(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = raw[key];
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return fallback;
}

function num(raw: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const v = raw[key];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Shape the flat stored values into the nested config, clamping every number
 *  so a hand-edited file can never wedge the spine. */
export function shapeSelfHealConfig(raw: Record<string, unknown>): SelfHealConfig {
  const d = SELF_HEAL_DEFAULTS;
  const triggers = {} as Record<TriggerType, boolean>;
  for (const t of TRIGGER_TYPES) triggers[t] = bool(raw, TRIGGER_KEYS[t], d.triggers[t]);
  return {
    enabled: bool(raw, "enabled", d.enabled),
    triggers,
    diagnostician: {
      scheduled: bool(raw, "diagnostician.scheduled", d.diagnostician.scheduled),
      idleThresholdSec: num(raw, "diagnostician.idleThresholdSec", d.diagnostician.idleThresholdSec, 30, 86_400),
    },
    autonomousImplement: bool(raw, "autonomousImplement", d.autonomousImplement),
    tdd: {
      required: bool(raw, "tdd.required", d.tdd.required),
      targetCoverage: num(raw, "tdd.targetCoverage", d.tdd.targetCoverage, 0, 100),
    },
    costCapPerDay: num(raw, "costCapPerDay", d.costCapPerDay, 0, 1_000_000_000),
    dedupeWindowSec: num(raw, "dedupeWindowSec", d.dedupeWindowSec, 0, 30 * 86_400),
    explicitDedupeWindowSec: num(raw, "explicitDedupeWindowSec", d.explicitDedupeWindowSec, 0, 30 * 86_400),
    suspendedTimeoutDays: num(raw, "suspendedTimeoutDays", d.suspendedTimeoutDays, 1, 365),
    costQueueMax: num(raw, "costQueueMax", d.costQueueMax, 1, 10_000),
    costQueueTtlDays: num(raw, "costQueueTtlDays", d.costQueueTtlDays, 1, 365),
    repeatedFailure: {
      count: num(raw, "repeatedFailure.count", d.repeatedFailure.count, 2, 100),
      windowSec: num(raw, "repeatedFailure.windowSec", d.repeatedFailure.windowSec, 10, 86_400),
    },
    hardError: {
      minCount: num(raw, "hardError.minCount", d.hardError.minCount, 1, 100),
    },
    stuckDetector: {
      enabled: bool(raw, "stuckDetector.enabled", d.stuckDetector.enabled),
      // Floored at 3: two identical calls in a row is a normal retry, not a
      // loop, so a hand-edited 1 or 2 must not make every run look stuck.
      repeatCalls: num(raw, "stuckDetector.repeatCalls", d.stuckDetector.repeatCalls, 3, 50),
    },
  };
}

/** Flatten a nested config back to storage keys (used by the load() side of the
 *  ConfigRegistration, so the Settings tab reads real defaults not blanks). */
export function flattenSelfHealConfig(cfg: SelfHealConfig): Record<string, unknown> {
  return {
    enabled: cfg.enabled,
    "triggers.explicit": cfg.triggers.explicit,
    "triggers.hardError": cfg.triggers["hard-error"],
    "triggers.repeatedFailure": cfg.triggers["repeated-failure"],
    "triggers.workflowTimeout": cfg.triggers["workflow-timeout"],
    "triggers.logEvents": cfg.triggers["log-events"],
    "diagnostician.scheduled": cfg.diagnostician.scheduled,
    "diagnostician.idleThresholdSec": cfg.diagnostician.idleThresholdSec,
    autonomousImplement: cfg.autonomousImplement,
    "tdd.required": cfg.tdd.required,
    "tdd.targetCoverage": cfg.tdd.targetCoverage,
    costCapPerDay: cfg.costCapPerDay,
    dedupeWindowSec: cfg.dedupeWindowSec,
    explicitDedupeWindowSec: cfg.explicitDedupeWindowSec,
    suspendedTimeoutDays: cfg.suspendedTimeoutDays,
    costQueueMax: cfg.costQueueMax,
    costQueueTtlDays: cfg.costQueueTtlDays,
    "repeatedFailure.count": cfg.repeatedFailure.count,
    "repeatedFailure.windowSec": cfg.repeatedFailure.windowSec,
    "hardError.minCount": cfg.hardError.minCount,
    "stuckDetector.enabled": cfg.stuckDetector.enabled,
    "stuckDetector.repeatCalls": cfg.stuckDetector.repeatCalls,
  };
}

/** Read the live config. Resolved per call (never cached) so the kill switch
 *  takes effect on the very next trigger — SC-006 depends on that. */
export async function readSelfHealConfig(): Promise<SelfHealConfig> {
  return shapeSelfHealConfig(await readNamespace("selfHeal"));
}

export async function patchSelfHealConfig(patch: Record<string, unknown>): Promise<void> {
  await patchNamespace("selfHeal", patch);
}

/** True when the mechanism as a whole AND this specific trigger are enabled
 *  (FR-006). The global switch wins. */
export function triggerEnabled(cfg: SelfHealConfig, trigger: TriggerType): boolean {
  return cfg.enabled && cfg.triggers[trigger] === true;
}
