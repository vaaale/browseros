// RunHooks — the server-side interception seam for the agent loop
// (framework-free). Features and embedding surfaces hook into a run's decision
// points; the loop stays ignorant of who is listening.
//
// Hooks are fallible guests: every invocation is caught and time-boxed, so a
// broken or slow hook can never wedge a run. Hooks that need to do long work
// (e.g. kick a background job on run finish) must spawn it and return.

import type { RunFinishReason } from "./run-events";
import type { TurnToolCall } from "./agent-loop";

export interface HookContext {
  runId: string;
  conversationId: string;
  agentId: string;
}

export interface ToolCallDecision {
  allow: boolean;
  reason?: string;
}

export interface RunHooks {
  /** Extra system-prompt text appended after the agent's composed instructions. */
  extendSystemPrompt?: (ctx: HookContext) => Promise<string | undefined>;
  /** Veto/inspect a tool call BEFORE it executes. A deny becomes an in-band
   *  `Error: <tool>: blocked …` tool result — the agent always learns why. */
  beforeToolCall?: (call: TurnToolCall, ctx: HookContext) => Promise<ToolCallDecision | void>;
  /** Observe a tool call's settled result (including in-band errors). */
  afterToolCall?: (call: TurnToolCall, result: string, ctx: HookContext) => Promise<void>;
  /** Observe run completion (any reason, including cancelled). */
  onRunFinished?: (summary: { reason: RunFinishReason; error?: string }, ctx: HookContext) => Promise<void>;
}

/** Per-invocation budget. Hooks are decision points, not workers. */
const HOOK_TIMEOUT_MS = 10_000;

async function guarded<T>(label: string, fn: () => Promise<T>, onError?: (msg: string) => void): Promise<T | undefined> {
  try {
    return await Promise.race([
      fn(),
      new Promise<undefined>((resolve) => {
        const t = setTimeout(() => resolve(undefined), HOOK_TIMEOUT_MS);
        t.unref?.();
      }),
    ]);
  } catch (e) {
    onError?.(`hook ${label} failed: ${(e as Error).message}`);
    return undefined;
  }
}

/** Fan-out composition over many hook sets:
 *  - extendSystemPrompt: results concatenate (blank-line separated);
 *  - beforeToolCall: the FIRST deny wins;
 *  - afterToolCall / onRunFinished: every hook runs.
 *  `onError` receives diagnostics (wire it to the logger). */
export function composeHooks(sets: RunHooks[], onError?: (msg: string) => void): RunHooks {
  const hooks = sets.filter(Boolean);
  return {
    extendSystemPrompt: async (ctx) => {
      const parts: string[] = [];
      for (const h of hooks) {
        if (!h.extendSystemPrompt) continue;
        const extra = await guarded("extendSystemPrompt", () => h.extendSystemPrompt!(ctx), onError);
        if (extra?.trim()) parts.push(extra.trim());
      }
      return parts.length ? parts.join("\n\n") : undefined;
    },
    beforeToolCall: async (call, ctx) => {
      for (const h of hooks) {
        if (!h.beforeToolCall) continue;
        const decision = await guarded("beforeToolCall", () => h.beforeToolCall!(call, ctx), onError);
        if (decision && decision.allow === false) return decision;
      }
      return { allow: true };
    },
    afterToolCall: async (call, result, ctx) => {
      for (const h of hooks) {
        if (!h.afterToolCall) continue;
        await guarded("afterToolCall", () => h.afterToolCall!(call, result, ctx), onError);
      }
    },
    onRunFinished: async (summary, ctx) => {
      for (const h of hooks) {
        if (!h.onRunFinished) continue;
        await guarded("onRunFinished", () => h.onRunFinished!(summary, ctx), onError);
      }
    },
  };
}

// ── Global registry ──────────────────────────────────────────────────────────
// BOS features (memory loops, telemetry, session state) register hooks that
// apply to EVERY run; per-run hooks are passed by in-process starters. Lives on
// globalThis so dev hot-reload keeps registrations coherent (re-registering
// under the same id replaces).

const g = globalThis as unknown as { __bosRunHooks?: Map<string, RunHooks> };

function registry(): Map<string, RunHooks> {
  if (!g.__bosRunHooks) g.__bosRunHooks = new Map();
  return g.__bosRunHooks;
}

export function registerRunHooks(id: string, hooks: RunHooks): void {
  registry().set(id, hooks);
}

export function unregisterRunHooks(id: string): void {
  registry().delete(id);
}

export function globalRunHooks(): RunHooks[] {
  return [...registry().values()];
}
