import "server-only";
import type {
  PluginDefinition,
  RunContext,
  PluginContext,
  PluginStatus,
  PluginsConfig,
} from "./types";
import type { ChatMessage } from "@/lib/assistant/messages";
import type { TurnToolCall } from "@/lib/assistant/agent-loop";
import type { ToolCallDecision } from "@/lib/assistant/hooks";
import type { RunFinishReason } from "@/lib/assistant/run-events";
import { trackStart, trackEnd } from "./monitor";

// ── Global registry ─────────────────────────────────────────────────────────
// Uses globalThis for hot-reload safety, matching the existing __bosRunHooks
// pattern in src/lib/assistant/hooks.ts.

const g = globalThis as unknown as { __bosPluginRegistry?: PluginRegistryState };

interface PluginRegistryState {
  plugins: Map<string, PluginDefinition>;
  contexts: Map<string, PluginContext>;
}

function state(): PluginRegistryState {
  if (!g.__bosPluginRegistry) {
    g.__bosPluginRegistry = { plugins: new Map(), contexts: new Map() };
  }
  return g.__bosPluginRegistry;
}

/** Register a plugin. Replaces any existing plugin with the same id. */
export function registerPlugin(def: PluginDefinition): void {
  state().plugins.set(def.manifest.id, def);
}

/** Unregister a plugin by id. Calls dispose() if available. */
export async function unregisterPlugin(id: string): Promise<void> {
  const def = state().plugins.get(id);
  if (def?.dispose) {
    try {
      await def.dispose();
    } catch {
      // Dispose errors are non-fatal.
    }
  }
  state().plugins.delete(id);
  state().contexts.delete(id);
}

/** Get a registered plugin by id. */
export function getPlugin(id: string): PluginDefinition | undefined {
  return state().plugins.get(id);
}

/** List all registered plugins in registration order. */
export function listPlugins(): PluginDefinition[] {
  return [...state().plugins.values()];
}

/** Get the context for a plugin. */
export function getPluginContext(id: string): PluginContext | undefined {
  return state().contexts.get(id);
}

/** Store a plugin context (called during initialization). */
export function setPluginContext(id: string, ctx: PluginContext): void {
  state().contexts.set(id, ctx);
}

// ── Hook composition ────────────────────────────────────────────────────────
// Composes plugin hooks into a single RunHooks-compatible object.
// Follows the same guarded semantics as src/lib/assistant/hooks.ts but adds
// beforeRun and afterRun which are new plugin-specific hook points.

const HOOK_TIMEOUT_MS = 15_000;

async function guarded<T>(label: string, fn: () => Promise<T>, onError?: (msg: string) => void): Promise<T | undefined> {
  const key = trackStart("pipeline", label);
  try {
    return await Promise.race([
      fn(),
      new Promise<undefined>((resolve) => {
        const t = setTimeout(() => resolve(undefined), HOOK_TIMEOUT_MS);
        t.unref?.();
      }),
    ]);
  } catch (e) {
    onError?.(`plugin hook ${label} failed: ${(e as Error).message}`);
    return undefined;
  } finally {
    trackEnd(key);
  }
}

/** Compose all plugin hooks into a single runnable pipeline.
 *  Returns an object that can be used as RunHooks plus beforeRun/afterRun. */
export function composePluginHooks(
  plugins: PluginDefinition[],
  onError?: (msg: string) => void,
): {
  beforeRun: (messages: ChatMessage[], ctx: RunContext) => Promise<ChatMessage[]>;
  extendSystemPrompt: (ctx: RunContext) => Promise<string | undefined>;
  beforeToolCall: (call: TurnToolCall, ctx: RunContext) => Promise<ToolCallDecision>;
  afterToolCall: (call: TurnToolCall, result: string, ctx: RunContext) => Promise<void>;
  afterRun: (response: { text: string; toolCalls: TurnToolCall[] }, ctx: RunContext) => Promise<{ text: string; toolCalls: TurnToolCall[] }>;
  onRunFinished: (summary: { reason: RunFinishReason; error?: string }, ctx: RunContext) => Promise<void>;
  onError: (error: Error, ctx: RunContext) => Promise<void>;
} {
  const active = plugins.filter((p) => p.hooks);

  return {
    beforeRun: async (messages, ctx) => {
      let current = messages;
      for (const p of active) {
        if (!p.hooks.beforeRun) continue;
        const result = await guarded("beforeRun", () => p.hooks.beforeRun!(current, ctx), onError);
        if (result) current = result;
      }
      return current;
    },

    extendSystemPrompt: async (ctx) => {
      const parts: string[] = [];
      for (const p of active) {
        if (!p.hooks.extendSystemPrompt) continue;
        const extra = await guarded("extendSystemPrompt", () => p.hooks.extendSystemPrompt!(ctx), onError);
        if (extra?.trim()) parts.push(extra.trim());
      }
      return parts.length ? parts.join("\n\n") : undefined;
    },

    beforeToolCall: async (call, ctx) => {
      for (const p of active) {
        if (!p.hooks.beforeToolCall) continue;
        const decision = await guarded("beforeToolCall", () => p.hooks.beforeToolCall!(call, ctx), onError);
        if (decision && decision.allow === false) return decision;
      }
      return { allow: true };
    },

    afterToolCall: async (call, result, ctx) => {
      for (const p of active) {
        if (!p.hooks.afterToolCall) continue;
        await guarded("afterToolCall", () => p.hooks.afterToolCall!(call, result, ctx), onError);
      }
    },

    afterRun: async (response, ctx) => {
      let current = response;
      for (const p of active) {
        if (!p.hooks.afterRun) continue;
        const result = await guarded("afterRun", () => p.hooks.afterRun!(current, ctx), onError);
        if (result) current = result;
      }
      return current;
    },

    onRunFinished: async (summary, ctx) => {
      for (const p of active) {
        if (!p.hooks.onRunFinished) continue;
        await guarded("onRunFinished", () => p.hooks.onRunFinished!(summary, ctx), onError);
      }
    },

    onError: async (error, ctx) => {
      for (const p of active) {
        if (!p.hooks.onError) continue;
        await guarded("onError", () => p.hooks.onError!(error, ctx), onError);
      }
    },
  };
}

// ── Config persistence ──────────────────────────────────────────────────────

export async function readPluginsConfig(): Promise<PluginsConfig> {
  const { readNamespace } = await import("@/lib/config/store");
  const raw = await readNamespace("plugins");
  return {
    active: Array.isArray(raw.active) ? (raw.active as string[]) : [],
    config: raw.config && typeof raw.config === "object" ? (raw.config as Record<string, Record<string, unknown>>) : {},
  };
}

export async function writePluginsConfig(config: PluginsConfig): Promise<void> {
  const { writeNamespace } = await import("@/lib/config/store");
  await writeNamespace("plugins", config as unknown as Record<string, unknown>);
}

export async function patchPluginConfig(pluginId: string, patch: Record<string, unknown>): Promise<void> {
  const config = await readPluginsConfig();
  config.config[pluginId] = { ...(config.config[pluginId] ?? {}), ...patch };
  await writePluginsConfig(config);
}

// ── Lifecycle helpers ────────────────────────────────────────────────────────
//
// Shared by every caller that needs to actually run a plugin's initialize/
// dispose hooks (not just flip its entry in plugins.json). Built-in plugins
// (memory, compaction) self-register via a side-effect import in their
// init.ts at module load — they are ALWAYS already in the in-memory registry
// by the time any of these run, unlike a freshly marketplace-installed plugin
// which still needs the disk hot-load path in activatePlugin() below.

async function buildPluginContext(id: string): Promise<PluginContext> {
  const { dataDir } = await import("@/os/data-dir");
  const path = await import("path");
  const fs = await import("fs");
  const { logger } = await import("@/lib/logging");
  const pluginDir = path.default.join(dataDir(), "plugins", id);
  return {
    dataDir: dataDir(),
    readFile: async (rel: string) => fs.promises.readFile(path.default.join(pluginDir, rel), "utf8"),
    writeFile: async (rel: string, content: string) => {
      const fullPath = path.default.join(pluginDir, rel);
      await fs.promises.mkdir(path.default.dirname(fullPath), { recursive: true });
      await fs.promises.writeFile(fullPath, content, "utf8");
    },
    readTranscript: async (convId: string) => {
      const { loadConversationMessages } = await import("@/lib/assistant/conversation-store");
      return loadConversationMessages(convId);
    },
    log: (level: "debug" | "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => {
      logger().log({ level, component: `plugins.${id}`, msg, ...(data ? { data } : {}) });
    },
  };
}

/** Call a registered plugin's initialize() if it hasn't run yet this process
 *  (tracked via the presence of its context). Idempotent — safe to call every
 *  time a plugin becomes active, whether that's the first time or the Nth. */
export async function ensurePluginInitialized(id: string): Promise<void> {
  const def = state().plugins.get(id);
  if (!def?.initialize || getPluginContext(id)) return;
  const ctx = await buildPluginContext(id);
  setPluginContext(id, ctx);
  await def.initialize(ctx);
}

/** Call a registered plugin's dispose() if it was initialized, then drop its
 *  context marker (so a later re-activation calls initialize() again).
 *  Deliberately does NOT remove the plugin from the in-memory registry —
 *  built-in plugins are only ever (re-)registered by their init.ts module
 *  running once at process start, so fully unregistering them here would
 *  make them unrecoverable without a server restart. */
export async function disposePluginIfInitialized(id: string): Promise<void> {
  const def = state().plugins.get(id);
  if (!def?.dispose || !getPluginContext(id)) return;
  await def.dispose();
  state().contexts.delete(id);
}

// ── Activation / deactivation ───────────────────────────────────────────────

export async function activatePlugin(id: string): Promise<void> {
  const config = await readPluginsConfig();
  if (!config.active.includes(id)) {
    config.active.push(id);
    await writePluginsConfig(config);
  }

  if (!state().plugins.has(id)) {
    // Hot-register: a plugin not yet in the in-memory registry (e.g. a fresh
    // marketplace install) needs loading from disk before it can initialize.
    try {
      const { loadPluginFromDir } = await import("./loader");
      const { dataDir } = await import("@/os/data-dir");
      const path = await import("path");
      const pluginDir = path.default.join(dataDir(), "plugins", id);
      const def = await loadPluginFromDir(pluginDir);
      if (def) registerPlugin(def);
    } catch {
      // Hot-register failure is non-fatal — plugin will be available after restart.
    }
  }

  await ensurePluginInitialized(id);
}

export async function deactivatePlugin(id: string): Promise<void> {
  const config = await readPluginsConfig();
  const idx = config.active.indexOf(id);
  if (idx !== -1) {
    config.active.splice(idx, 1);
    await writePluginsConfig(config);
  }
  await unregisterPlugin(id);
}

export async function reorderPlugins(orderedIds: string[]): Promise<void> {
  const config = await readPluginsConfig();
  config.active = orderedIds;
  await writePluginsConfig(config);
}

// ── Plugin status (for Settings UI) ─────────────────────────────────────────

export async function getPluginStatuses(): Promise<PluginStatus[]> {
  const config = await readPluginsConfig();
  const plugins = listPlugins();
  return plugins.map((p) => ({
    id: p.manifest.id,
    manifest: p.manifest,
    active: config.active.includes(p.manifest.id),
    config: config.config[p.manifest.id] ?? {},
  }));
}
