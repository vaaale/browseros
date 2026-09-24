import type { PluginDefinition, PluginContext, RunContext } from "@/lib/plugins/types";
import type { TurnToolCall } from "@/lib/assistant/agent-loop";
import { logger } from "@/lib/logging";

// The self-heal trigger-capture plugin (031-self-healing FR-002/FR-003).
//
// It rides the MAIN CHAT run loop's hooks and turns tool failures into spine
// triggers. Two triggers live here:
//   hard-error       — one non-environmental thrown/in-band tool error;
//   repeated-failure — N consecutive same-signature failures within a window.
//
// Three things about the hook path shape this file:
//
//  1. HEADLESS RUNS NEVER REACH HERE. `runLocalHeadless` calls `runAgentLoop`
//     without a `hooks` argument; `composePluginHooks` is wired only into
//     src/lib/assistant/start-run.ts. So the Diagnostician's own run, and the
//     autonomous BS pipeline it spawns, cannot fire these hooks at all — which
//     is FR-025's primary recursion risk closed by construction, not by a check
//     (design ADR-4). The conversation-marker check below covers the one
//     remaining path: a self-heal conversation later driven from the chat UI.
//
//  2. THE LOOP TURNS TOOL FAILURES INTO STRINGS, NOT THROWS. Every tool failure
//     reaches the model as an in-band `Error: <tool>: …` result (agent-loop.ts)
//     — `onError` only fires for a MODEL-turn failure. So `afterToolCall` is the
//     real capture point, and it inspects the result string.
//
//  3. HOOKS ARE TIME-BOXED (10s) AND MUST NOT BLOCK. Intake is fast by design
//     (the Diagnostician is launched fire-and-forget), but the call is still
//     dispatched without awaiting so a slow disk can never stall a chat turn.

/** In-memory rolling window per (conversation, tool, signature). Deliberately
 *  NOT persisted: the repeated-failure trigger is about a burst inside one live
 *  run, and a window that survived restarts would fire on stale history. */
interface FailureWindow {
  timestamps: number[];
}

const windows = new Map<string, FailureWindow>();

/** Exported so the unit test can drive the window logic directly. */
export function _resetWindowsForTests(): void {
  windows.clear();
}

// Intake is dispatched WITHOUT awaiting (below) so a slow disk can never stall
// a chat turn — but that means a call can still be in flight after the hook
// returns. Tracking the in-flight set costs one Set operation and gives tests a
// way to wait for settlement; without it, a test's fire-and-forget intake lands
// in the NEXT test's data dir and fails it instead.
const inFlight = new Set<Promise<unknown>>();

function dispatchIntake(work: Promise<unknown>): void {
  inFlight.add(work);
  void work.catch(() => undefined).finally(() => inFlight.delete(work));
}

/** Tests only: settle every intake this plugin has dispatched so far. */
export function drainPendingIntakes(): Promise<unknown> {
  return Promise.allSettled([...inFlight]);
}

/** The in-band failure convention from agent-loop.ts's `toolError`. */
export function isToolErrorResult(result: string): boolean {
  return typeof result === "string" && result.startsWith("Error: ");
}

/** Strip the `Error: <tool>: ` prefix so the signature hashes the real message
 *  rather than the tool name twice. */
export function toolErrorMessage(toolName: string, result: string): string {
  const withPrefix = result.replace(/^Error:\s*/, "");
  const withoutTool = withPrefix.startsWith(`${toolName}:`) ? withPrefix.slice(toolName.length + 1) : withPrefix;
  return withoutTool.trim();
}

/**
 * Record one failure and report whether the repeated-failure threshold is now
 * met. Pure bookkeeping over the rolling window; the caller decides what to do.
 */
export function recordFailure(
  key: string,
  now: number,
  count: number,
  windowSec: number,
): { total: number; threshold: boolean } {
  const w = windows.get(key) ?? { timestamps: [] };
  const cutoff = now - windowSec * 1000;
  w.timestamps = w.timestamps.filter((t) => t > cutoff);
  w.timestamps.push(now);
  windows.set(key, w);
  if (w.timestamps.length >= count) {
    // Reset on fire, so a long-running failure doesn't re-trigger on every
    // subsequent call (dedupe would suppress it, but not for free).
    windows.set(key, { timestamps: [] });
    return { total: count, threshold: true };
  }
  return { total: w.timestamps.length, threshold: false };
}

/** A successful call clears the streak — "consecutive" in FR-003 means
 *  consecutive. */
export function clearFailures(key: string): void {
  windows.delete(key);
}

async function spine() {
  const [{ selfHealIntake }, { readSelfHealConfig, triggerEnabled }, { isEnvironmentalError }, { computeFailureSignature }, { isSelfHealConversation }] =
    await Promise.all([
      import("@/lib/self-heal/intake"),
      import("@/lib/self-heal/config"),
      import("@/lib/self-heal/allowlist"),
      import("@/lib/self-heal/signature"),
      import("@/lib/self-heal/reentrancy"),
    ]);
  return { selfHealIntake, readSelfHealConfig, triggerEnabled, isEnvironmentalError, computeFailureSignature, isSelfHealConversation };
}

async function onToolSettled(call: TurnToolCall, result: string, ctx: RunContext): Promise<void> {
  const {
    selfHealIntake,
    readSelfHealConfig,
    triggerEnabled,
    isEnvironmentalError,
    computeFailureSignature,
    isSelfHealConversation,
  } = await spine();

  const cfg = await readSelfHealConfig();
  const hardError = triggerEnabled(cfg, "hard-error");
  const repeated = triggerEnabled(cfg, "repeated-failure");
  // Cheapest possible exit when the mechanism (or both its triggers) is off —
  // SC-006 requires zero work, not just zero cases.
  if (!hardError && !repeated) return;

  const failed = isToolErrorResult(result);
  const windowKey = `${ctx.conversationId}|${call.name}`;
  if (!failed) {
    clearFailures(windowKey);
    return;
  }

  // FR-025 guard (a): a self-heal-origin conversation being driven from chat.
  if (await isSelfHealConversation(ctx.conversationId)) return;

  const errorMessage = toolErrorMessage(call.name, result);
  if (isEnvironmentalError({ errorMessage })) {
    // Environmental failures don't count toward the repeated-failure streak
    // either: three network blips are not a BOS gap.
    return;
  }

  const signature = computeFailureSignature({ trigger: "hard-error", toolName: call.name, errorMessage });
  const streakKey = `${windowKey}|${signature.normalizedHash}`;
  // The window's fire-and-reset threshold: the repeated-failure count when that
  // trigger owns the streak, otherwise the hard-error minimum — so a minCount
  // above the repeated count still gets a window to accumulate in.
  const streakThreshold = repeated ? cfg.repeatedFailure.count : cfg.hardError.minCount;
  const streak = recordFailure(streakKey, Date.now(), streakThreshold, cfg.repeatedFailure.windowSec);

  if (repeated && streak.threshold) {
    dispatchIntake(
      selfHealIntake({
        trigger: "repeated-failure",
        toolName: call.name,
        errorMessage,
        conversationId: ctx.conversationId,
        repeated: { count: cfg.repeatedFailure.count, windowSec: cfg.repeatedFailure.windowSec },
      }),
    );
    return;
  }
  if (!hardError) return;
  // FR-002 (amended): the hard-error threshold must not preempt the
  // repeated-failure one. Firing here at a count below repeatedFailure.count
  // would open a hard-error case whose dedupe entry then suppresses the
  // streak's own repeated-failure trigger — so with both triggers on and a
  // lower minimum, the streak belongs to that trigger and this one stands down.
  if (repeated && cfg.hardError.minCount < cfg.repeatedFailure.count) {
    logger().info("self-heal", "hard-error deferred to the repeated-failure trigger", {
      tool: call.name,
      count: streak.total,
      repeatedCount: cfg.repeatedFailure.count,
    });
    return;
  }
  if (streak.total < cfg.hardError.minCount) {
    // FR-002: below the threshold is logged, never silent — and never a case.
    logger().info("self-heal", "hard-error below minCount threshold, logging only", {
      tool: call.name,
      count: streak.total,
      minCount: cfg.hardError.minCount,
    });
    return;
  }
  dispatchIntake(
    selfHealIntake({
      trigger: "hard-error",
      toolName: call.name,
      errorMessage,
      conversationId: ctx.conversationId,
    }),
  );
}

const selfHealPlugin: PluginDefinition = {
  manifest: {
    id: "bos-self-heal",
    name: "Self-Healing Triggers",
    version: "1.0.0",
    type: "server-plugin",
    provides: ["afterToolCall", "onError"],
    description:
      "Watches the chat run loop for tool failures and hands them to the self-healing mechanism: one non-environmental error (hard-error trigger) or N consecutive same-signature failures (repeated-failure trigger). Configure it in Settings → Self Improvement.",
    settingsRegistration: {
      label: "Self-Healing Triggers",
      icon: "🩹",
      order: 18,
      description:
        "Configure this in Settings → Self Improvement (the dedicated tab with the per-trigger toggles and limits), not here.",
    },
  },
  hooks: {
    afterToolCall: async (call, result, ctx) => {
      // Never let a trigger-capture problem affect the chat run. The hook layer
      // already guards and time-boxes us; this makes the intent explicit.
      try {
        await onToolSettled(call, result, ctx);
      } catch {
        /* a failed trigger capture is not worth failing a turn over */
      }
    },
    onError: async (error, ctx) => {
      // Fires for a MODEL-turn failure, not a tool failure. Provider errors are
      // overwhelmingly environmental (rate limit, auth, upstream timeout) and
      // the allowlist filters them — but a genuine BOS-side failure here is
      // exactly the kind of gap worth diagnosing, so it goes through the same
      // front door and lets the deterministic filters decide.
      try {
        const { selfHealIntake, readSelfHealConfig, triggerEnabled, isEnvironmentalError } = await spine();
        const cfg = await readSelfHealConfig();
        if (!triggerEnabled(cfg, "hard-error")) return;
        const errorMessage = error?.message ?? String(error);
        if (isEnvironmentalError({ errorMessage })) return;
        dispatchIntake(
          selfHealIntake({
            trigger: "hard-error",
            toolName: `assistant.model-turn`,
            errorMessage,
            conversationId: ctx.conversationId,
          }),
        );
      } catch {
        /* same reasoning as above */
      }
    },
  },
  initialize: async (ctx: PluginContext) => {
    ctx.log("info", "self-heal trigger plugin initialized");
  },
  dispose: async () => {
    windows.clear();
  },
};

export default selfHealPlugin;
