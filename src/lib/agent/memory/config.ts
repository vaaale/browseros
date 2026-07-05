import "server-only";
import { readNamespace } from "@/lib/config/store";

// Resolved memoryLoops configuration with defaults. The `memoryLoops` namespace
// in the config registry (src/lib/config/registry.ts) is the sole source of
// truth; this module just provides a strongly-typed reader with defaults so
// the fast/slow loops don't sprinkle magic numbers.

export interface MemoryLoopsConfig {
  fastLoop: {
    enabled: boolean;
    tickIntervalSec: number;
    idleThresholdSec: number;
    turnCap: number;
    minNewTurns: number;
  };
  slowLoop: {
    enabled: boolean;
    intervalSec: number;
    batchSize: number;
  };
  modelOverride?: string;
  episodeArchiveAgeDays: number;
  topicBudget: number;
}

const DEFAULTS: MemoryLoopsConfig = {
  fastLoop: {
    enabled: true,
    tickIntervalSec: 120,
    idleThresholdSec: 300,
    turnCap: 40,
    minNewTurns: 4,
  },
  slowLoop: {
    enabled: true,
    intervalSec: 3600,
    batchSize: 10,
  },
  episodeArchiveAgeDays: 14,
  topicBudget: 4000,
};

function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return fallback;
}

export async function getMemoryLoopsConfig(): Promise<MemoryLoopsConfig> {
  const stored = await readNamespace("memoryLoops");
  return {
    fastLoop: {
      enabled: bool(stored["fastLoop.enabled"], DEFAULTS.fastLoop.enabled),
      tickIntervalSec: num(stored["fastLoop.tickIntervalSec"], DEFAULTS.fastLoop.tickIntervalSec),
      idleThresholdSec: num(stored["fastLoop.idleThresholdSec"], DEFAULTS.fastLoop.idleThresholdSec),
      turnCap: num(stored["fastLoop.turnCap"], DEFAULTS.fastLoop.turnCap),
      minNewTurns: num(stored["fastLoop.minNewTurns"], DEFAULTS.fastLoop.minNewTurns),
    },
    slowLoop: {
      enabled: bool(stored["slowLoop.enabled"], DEFAULTS.slowLoop.enabled),
      intervalSec: num(stored["slowLoop.intervalSec"], DEFAULTS.slowLoop.intervalSec),
      batchSize: num(stored["slowLoop.batchSize"], DEFAULTS.slowLoop.batchSize),
    },
    modelOverride: typeof stored.modelOverride === "string" && stored.modelOverride.trim()
      ? String(stored.modelOverride)
      : undefined,
    episodeArchiveAgeDays: num(stored.episodeArchiveAgeDays, DEFAULTS.episodeArchiveAgeDays),
    topicBudget: num(stored.topicBudget, DEFAULTS.topicBudget),
  };
}

export function memoryLoopsDefaults(): MemoryLoopsConfig {
  return {
    ...DEFAULTS,
    fastLoop: { ...DEFAULTS.fastLoop },
    slowLoop: { ...DEFAULTS.slowLoop },
  };
}
