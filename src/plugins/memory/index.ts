import type { PluginDefinition, PluginContext } from "@/lib/plugins/types";
import { logger } from "@/lib/logging";

// Memory plugin — wraps the existing memory system (fast-loop + slow-loop)
// into a plugin. The memory loops run exclusively as scheduler jobs; this
// plugin only surfaces their configuration in Settings.

async function getMemoryLoopsConfig() {
  const { getMemoryLoopsConfig } = await import("@/lib/agent/memory/config");
  return getMemoryLoopsConfig();
}

// ── Mutex guard ───────────────────────────────────────────────────────────
// Prevents concurrent activate/deactivate from racing each other.

let _lifecyclePromise: Promise<void> | null = null;

async function runLifecycle(fn: () => Promise<void>): Promise<void> {
  const prev = _lifecyclePromise;
  _lifecyclePromise = (async () => {
    if (prev) await prev;
    await fn();
  })();
  return _lifecyclePromise;
}

// ── Job lifecycle helpers ─────────────────────────────────────────────────

async function seedAndResumeJobs(): Promise<void> {
  const { ensureFastLoopJob } = await import("@/lib/agent/memory/fast-loop");
  const { ensureSlowLoopJob } = await import("@/lib/agent/memory/consolidate");
  const { resumeJob } = await import("@/lib/scheduler/engine");

  await ensureFastLoopJob();
  await resumeJob("system:memory.fast-loop");
  await ensureSlowLoopJob();
  await resumeJob("system:memory.slow-loop");
}

async function pauseJobs(): Promise<void> {
  const { pauseJob } = await import("@/lib/scheduler/engine");

  await pauseJob("system:memory.fast-loop");
  await pauseJob("system:memory.slow-loop");
}

const memoryPlugin: PluginDefinition = {
  manifest: {
    id: "bos-memory",
    name: "Memory System",
    version: "1.0.0",
    type: "server-plugin",
    provides: [],
    description:
      "Automated memory reflection. Fast loop reviews idle conversations and writes episodes; slow loop consolidates into long-term memory.",
    settingsRegistration: {
      label: "Memory Loops",
      icon: "🧠",
      order: 15,
      description: "Automated memory reflection and consolidation.",
    },
    configSchema: {
      type: "object",
      title: "Memory Loops",
      properties: {
        "fastLoop.enabled": { type: "boolean", title: "Fast loop enabled", description: "Automatically review idle conversations and write episodes." },
        "fastLoop.tickIntervalSec": { type: "number", title: "Fast loop tick (seconds)", description: "How often the fast loop wakes up. Default 120.", default: 120 },
        "fastLoop.idleThresholdSec": { type: "number", title: "Idle threshold (seconds)", description: "A conversation must be idle this long before it's eligible for review. Default 300.", default: 300 },
        "fastLoop.turnCap": { type: "number", title: "Unreviewed turn cap", description: "Force a review when this many new turns pile up. Default 40.", default: 40 },
        "fastLoop.minNewTurns": { type: "number", title: "Minimum new turns", description: "Skip conversations with fewer new assistant turns than this. Default 4.", default: 4 },
        "slowLoop.enabled": { type: "boolean", title: "Slow loop enabled", description: "Consolidate pending episodes into long-term memory topics and skills." },
        "slowLoop.intervalSec": { type: "number", title: "Slow loop interval (seconds)", description: "How often the slow loop runs. Default 3600.", default: 3600 },
        "slowLoop.batchSize": { type: "number", title: "Slow loop batch size", description: "Max pending episodes processed per run. Default 10.", default: 10 },
        modelOverride: { type: "string", title: "Model override", description: "Optional model id to override the default provider for both loops." },
        episodeArchiveAgeDays: { type: "number", title: "Archive age (days)", description: "Consolidated episodes older than this move to .Archive/. Default 14.", default: 14 },
        topicBudget: { type: "number", title: "Topic budget (chars)", description: "Per-topic character budget before a new shard is created. Default 4000.", default: 4000 },
      },
    } as Record<string, unknown>,
  },
  hooks: {},
  initialize: async (ctx: PluginContext) => {
    await runLifecycle(async () => {
      try {
        await seedAndResumeJobs();
        ctx.log("info", "memory plugin: scheduler jobs seeded and resumed");
      } catch (error) {
        ctx.log("error", "memory plugin: failed to seed scheduler jobs", { error: (error as Error).message });
      }
    });
  },
  dispose: async () => {
    await runLifecycle(async () => {
      try {
        await pauseJobs();
      } catch (error) {
        logger().error("plugins.memory", "failed to pause scheduler jobs", undefined, {
          error: (error as Error).message,
        });
      }
    });
  },
  getConfig: async () => {
    const config = await getMemoryLoopsConfig();
    return config as unknown as Record<string, unknown>;
  },
  setConfig: async (config: Record<string, unknown>) => {
    const { patchPluginConfig } = await import("@/lib/plugins/registry");
    await patchPluginConfig("bos-memory", config);
    // Re-seed jobs with new intervals
    try {
      await seedAndResumeJobs();
    } catch (error) {
      logger().error("plugins.memory", "failed to re-seed scheduler jobs after config change", undefined, {
        error: (error as Error).message,
      });
    }
  },
};

export default memoryPlugin;
