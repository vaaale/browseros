import "server-only";
import { getConfigValue } from "@/lib/config/registry";
import { logger } from "@/lib/logging";

// Typed getters for the `compaction` config namespace (spec 022 FR-018).
// Defaults live here so the middleware has a deterministic baseline before the
// namespace is registered/populated at first run.

export interface CompactionConfig {
  enabled: boolean;
  assumedContextTokens: number;
  clearThreshold: number;
  summarizeThreshold: number;
  hardLimit: number;
  keepToolResults: number;
  keepTailMessages: number;
  tailBudgetFraction: number;
  unrecoverableTools: string[];
  model?: string;
  lockStalenessMs: number;
}

export const COMPACTION_DEFAULTS: CompactionConfig = {
  enabled: true,
  assumedContextTokens: 128_000,
  clearThreshold: 0.5,
  summarizeThreshold: 0.75,
  hardLimit: 0.92,
  keepToolResults: 5,
  keepTailMessages: 10,
  tailBudgetFraction: 0.2,
  unrecoverableTools: [],
  lockStalenessMs: 600_000,
};

const NAMESPACE = "compaction";

let invalidWarnedThisProcess = false;

function coerceBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v;
  return fallback;
}

function coerceNumber(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return fallback;
}

function coerceFraction(v: unknown, fallback: number): number {
  const n = coerceNumber(v, fallback);
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function coerceStringArray(v: unknown, fallback: string[]): string[] {
  if (Array.isArray(v)) return v.filter((s): s is string => typeof s === "string" && s.trim().length > 0);
  if (typeof v === "string") {
    return v
      .split(/[,\s;]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return fallback;
}

async function readNamespaceValue(key: keyof CompactionConfig | "unrecoverableTools"): Promise<unknown> {
  try {
    return await getConfigValue(NAMESPACE, key);
  } catch {
    return undefined;
  }
}

// Small per-request cache so multiple middleware entries in one turn (tool
// loop steps) do not re-read the config file on every call.
let cached: { at: number; value: CompactionConfig } | null = null;
const CACHE_TTL_MS = 1500;

/** Read the current compaction config. Merges saved values over defaults; on
 *  an invalid threshold triple (clear < summarize < hard), logs once and
 *  falls back to defaults. */
export async function readCompactionConfig(): Promise<CompactionConfig> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.value;
  const [enabled, assumedContextTokens, clearThreshold, summarizeThreshold, hardLimit, keepToolResults, keepTailMessages, tailBudgetFraction, unrecoverableTools, model, lockStalenessMs] = await Promise.all([
    readNamespaceValue("enabled"),
    readNamespaceValue("assumedContextTokens"),
    readNamespaceValue("clearThreshold"),
    readNamespaceValue("summarizeThreshold"),
    readNamespaceValue("hardLimit"),
    readNamespaceValue("keepToolResults"),
    readNamespaceValue("keepTailMessages"),
    readNamespaceValue("tailBudgetFraction"),
    readNamespaceValue("unrecoverableTools"),
    readNamespaceValue("model"),
    readNamespaceValue("lockStalenessMs"),
  ]);
  const merged: CompactionConfig = {
    enabled: coerceBool(enabled, COMPACTION_DEFAULTS.enabled),
    assumedContextTokens: Math.max(1024, coerceNumber(assumedContextTokens, COMPACTION_DEFAULTS.assumedContextTokens)),
    clearThreshold: coerceFraction(clearThreshold, COMPACTION_DEFAULTS.clearThreshold),
    summarizeThreshold: coerceFraction(summarizeThreshold, COMPACTION_DEFAULTS.summarizeThreshold),
    hardLimit: coerceFraction(hardLimit, COMPACTION_DEFAULTS.hardLimit),
    keepToolResults: Math.max(0, Math.floor(coerceNumber(keepToolResults, COMPACTION_DEFAULTS.keepToolResults))),
    keepTailMessages: Math.max(1, Math.floor(coerceNumber(keepTailMessages, COMPACTION_DEFAULTS.keepTailMessages))),
    tailBudgetFraction: coerceFraction(tailBudgetFraction, COMPACTION_DEFAULTS.tailBudgetFraction),
    unrecoverableTools: coerceStringArray(unrecoverableTools, COMPACTION_DEFAULTS.unrecoverableTools),
    model: typeof model === "string" && model.trim() ? model.trim() : undefined,
    lockStalenessMs: Math.max(1000, coerceNumber(lockStalenessMs, COMPACTION_DEFAULTS.lockStalenessMs)),
  };
  let final = merged;
  if (!(merged.clearThreshold < merged.summarizeThreshold && merged.summarizeThreshold < merged.hardLimit)) {
    if (!invalidWarnedThisProcess) {
      invalidWarnedThisProcess = true;
      logger().error("compaction", "config.invalid thresholds — falling back to defaults", undefined, {
        clearThreshold: merged.clearThreshold,
        summarizeThreshold: merged.summarizeThreshold,
        hardLimit: merged.hardLimit,
      });
    }
    final = { ...merged, clearThreshold: COMPACTION_DEFAULTS.clearThreshold, summarizeThreshold: COMPACTION_DEFAULTS.summarizeThreshold, hardLimit: COMPACTION_DEFAULTS.hardLimit };
  }
  cached = { at: now, value: final };
  return final;
}

/** Reset the process-local cache (used by tests). */
export function _resetCompactionConfigCache(): void {
  cached = null;
  invalidWarnedThisProcess = false;
}
