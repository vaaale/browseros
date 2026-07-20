// Plugin pipeline types — framework-free (shared between server, client, tests).
// Defines the contract between BOS and its optional server-side plugins.

import type { ChatMessage } from "@/lib/assistant/messages";
import type { TurnToolCall } from "@/lib/assistant/agent-loop";
import type { ToolCallDecision, HookContext } from "@/lib/assistant/hooks";
import type { RunFinishReason } from "@/lib/assistant/run-events";

// ── Hook context (re-export for convenience) ────────────────────────────────

export type RunContext = HookContext;

// ── Plugin hooks ────────────────────────────────────────────────────────────

export interface BosPluginHooks {
  /** Run before the LLM call. Can inspect/modify messages. Return the
   *  (possibly modified) message array, or undefined to pass through. */
  beforeRun?: (messages: ChatMessage[], ctx: RunContext) => Promise<ChatMessage[] | undefined>;
  /** Extend the system prompt with extra text. Multiple plugins concatenate. */
  extendSystemPrompt?: (ctx: RunContext) => Promise<string | undefined>;
  /** Veto/inspect a tool call BEFORE execution. First deny wins. */
  beforeToolCall?: (call: TurnToolCall, ctx: RunContext) => Promise<ToolCallDecision | void>;
  /** Observe a tool call's settled result. */
  afterToolCall?: (call: TurnToolCall, result: string, ctx: RunContext) => Promise<void>;
  /** Run after the LLM responds. Can inspect/modify the response. */
  afterRun?: (response: LLMResponse, ctx: RunContext) => Promise<LLMResponse | undefined>;
  /** Observe run completion (any reason). */
  onRunFinished?: (summary: RunFinishSummary, ctx: RunContext) => Promise<void>;
  /** Handle errors that occur during the run. */
  onError?: (error: Error, ctx: RunContext) => Promise<void>;
}

// ── Response types used by hooks ────────────────────────────────────────────

export interface LLMResponse {
  text: string;
  toolCalls: TurnToolCall[];
}

export interface RunFinishSummary {
  reason: RunFinishReason;
  error?: string;
}

// ── Plugin manifest (plugin.json) ───────────────────────────────────────────

export type PluginHookType = keyof BosPluginHooks;

export interface PluginManifest {
  /** Unique plugin identifier (e.g. "bos-compaction", "community-telemetry"). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Semver version string. */
  version: string;
  /** Always "server-plugin" for now. */
  type: "server-plugin";
  /** Hook types this plugin implements. */
  provides: PluginHookType[];
  /** Optional JSON Schema for plugin configuration. */
  configSchema?: Record<string, unknown>;
  /** Entry module path (relative to plugin dir). Default "index.js". */
  entry?: string;
  /** Optional config app (HTML/JS path relative to plugin dir). */
  configApp?: string;
  /** Settings registration metadata. */
  settingsRegistration?: PluginSettingsRegistration;
  /** Human-readable description. */
  description?: string;
  /** Plugin author. */
  author?: string;
  /** Plugin homepage URL. */
  homepage?: string;
}

export interface PluginSettingsRegistration {
  label: string;
  icon?: string;
  order?: number;
  description?: string;
}

// ── Plugin definition (runtime) ─────────────────────────────────────────────

export interface PluginDefinition {
  manifest: PluginManifest;
  hooks: BosPluginHooks;
  /** Called once at plugin load time. */
  initialize?: (context: PluginContext) => Promise<void>;
  /** Called on deactivation or shutdown. */
  dispose?: () => Promise<void>;
  /** Get the plugin's current configuration. */
  getConfig?: () => Promise<Record<string, unknown>>;
  /** Set the plugin's configuration. */
  setConfig?: (config: Record<string, unknown>) => Promise<void>;
}

// ── Plugin context (APIs provided to plugins) ───────────────────────────────

export interface PluginContext {
  /** The data directory root. */
  dataDir: string;
  /** Read a file from the plugin's own directory. */
  readFile: (relativePath: string) => Promise<string>;
  /** Write a file to the plugin's own directory. */
  writeFile: (relativePath: string, content: string) => Promise<void>;
  /** Read the conversation transcript. */
  readTranscript: (conversationId: string) => Promise<ChatMessage[]>;
  /** Log a message. */
  log: (level: "debug" | "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => void;
}

// ── Plugin config (data/config/plugins.json) ────────────────────────────────

export interface PluginsConfig {
  /** Ordered list of active plugin IDs. Execution order follows array order. */
  active: string[];
  /** Per-plugin configuration keyed by plugin ID. */
  config: Record<string, Record<string, unknown>>;
}

// ── Plugin status (for Settings UI) ─────────────────────────────────────────

export interface PluginStatus {
  id: string;
  manifest: PluginManifest;
  active: boolean;
  config: Record<string, unknown>;
  error?: string;
}
