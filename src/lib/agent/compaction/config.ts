import "server-only";
import { readPluginsConfig } from "@/lib/plugins/registry";
import { logger } from "@/lib/logging";

// Typed getters for the compaction plugin's config (spec 022 FR-018, redesigned
// per the block-based compaction rewrite). Defaults live here so the pipeline
// has a deterministic baseline before the plugin config has ever been saved.
//
// Reads straight from the plugin store (`data/config/plugins.json`'s
// `config["bos-compaction"]`, via src/lib/plugins/registry.ts's
// readPluginsConfig) — the SAME store Settings writes to. Previously this went
// through src/lib/config/registry.ts's generic getConfigValue("compaction", key),
// but no ConfigRegistration for the bare "compaction" namespace existed, so
// every read silently fell back to defaults regardless of what was saved. The
// Settings-facing ConfigRegistration (registry.ts) now delegates its own
// load() to readCompactionConfig() below, so there is exactly one reader.

const PLUGIN_ID = "bos-compaction";

export interface CompactionConfig {
  enabled: boolean;
  assumedContextTokens: number;
  clearThreshold: number;
  summarizeThreshold: number;
  hardLimit: number;
  keepToolResults: number;
  /** Minimum size (in turns, not messages) of the always-verbatim live tail. */
  keepTailTurns: number;
  tailBudgetFraction: number;
  unrecoverableTools: string[];
  model?: string;
  lockStalenessMs: number;
  /** Turns folded into one block summary at a time. */
  blockSize: number;
  /** Block summaries retained before the oldest is evicted (permanently, no trace). */
  maxRetainedBlocks: number;
}

export const COMPACTION_DEFAULTS: CompactionConfig = {
  enabled: true,
  assumedContextTokens: 128_000,
  clearThreshold: 0.5,
  summarizeThreshold: 0.75,
  hardLimit: 0.92,
  keepToolResults: 2,
  keepTailTurns: 3,
  tailBudgetFraction: 0.2,
  unrecoverableTools: [],
  lockStalenessMs: 600_000,
  blockSize: 5,
  maxRetainedBlocks: 8,
};

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

  const stored = ((await readPluginsConfig()).config[PLUGIN_ID] ?? {}) as Record<string, unknown>;

  const merged: CompactionConfig = {
    enabled: coerceBool(stored.enabled, COMPACTION_DEFAULTS.enabled),
    assumedContextTokens: Math.max(1024, coerceNumber(stored.assumedContextTokens, COMPACTION_DEFAULTS.assumedContextTokens)),
    clearThreshold: coerceFraction(stored.clearThreshold, COMPACTION_DEFAULTS.clearThreshold),
    summarizeThreshold: coerceFraction(stored.summarizeThreshold, COMPACTION_DEFAULTS.summarizeThreshold),
    hardLimit: coerceFraction(stored.hardLimit, COMPACTION_DEFAULTS.hardLimit),
    keepToolResults: Math.max(0, Math.floor(coerceNumber(stored.keepToolResults, COMPACTION_DEFAULTS.keepToolResults))),
    keepTailTurns: Math.max(1, Math.floor(coerceNumber(stored.keepTailTurns, COMPACTION_DEFAULTS.keepTailTurns))),
    tailBudgetFraction: coerceFraction(stored.tailBudgetFraction, COMPACTION_DEFAULTS.tailBudgetFraction),
    unrecoverableTools: coerceStringArray(stored.unrecoverableTools, COMPACTION_DEFAULTS.unrecoverableTools),
    model: typeof stored.model === "string" && stored.model.trim() ? stored.model.trim() : undefined,
    lockStalenessMs: Math.max(1000, coerceNumber(stored.lockStalenessMs, COMPACTION_DEFAULTS.lockStalenessMs)),
    blockSize: Math.max(1, Math.floor(coerceNumber(stored.blockSize, COMPACTION_DEFAULTS.blockSize))),
    maxRetainedBlocks: Math.max(1, Math.floor(coerceNumber(stored.maxRetainedBlocks, COMPACTION_DEFAULTS.maxRetainedBlocks))),
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
