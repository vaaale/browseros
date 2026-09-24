import "server-only";
import { markTranscriptCaseId } from "@/lib/agent/subagents/transcript";
import type { AgentRunEndedReason, SubAgentEvent } from "@/lib/agent/subagents/types";
import { readSelfHealConfig } from "./config";
import { appendRun, getCase, setStuckSignature, updateRunStatus } from "./store";
import { casePayload, emitSelfHeal, summaryFor, SELF_HEAL_LOG } from "./events";
import { logger } from "@/lib/logging";
import { StuckDetector, type StuckVerdict } from "./stuck-detector";
import { SELF_HEAL_DEFAULTS, SELF_HEAL_EVENTS, type CaseRunRole, type CaseRunStatus, type StuckSignature } from "./types";

// The case↔run seam (031-self-healing scope-add, design ADR-12/ADR-13).
//
// Both runs the spine launches — the Diagnostician and the Build Studio
// pipeline — go through `runSubAgent`, which already forwards every
// `tool_call`/`tool_result`/`reasoning_delta`/`final_text` to an `onEvent`
// callback. Neither seam used to pass one. This module is what goes in there:
// one observer per run that
//
//   1. records the run on its case the moment `run_started` arrives (which is
//      how the case learns the runId while the run is IN FLIGHT — the returned
//      result is far too late for a fire-and-forget run, and Stop needs the id),
//   2. stamps the case id onto the run's transcript so the file is
//      self-describing (ADR-10 keeps the platform writer case-agnostic),
//   3. feeds every tool call to the deterministic stuck detector and, on a
//      fire, records the signature and announces `run_stuck` — once,
//   4. records how the run ended, and tells the caller whether it ended STUCK
//      so the spine can put the case in `stopped` instead of `failed`.
//
// It lives in its own module rather than in intake.ts because BOTH intake.ts
// and diagnostician.ts need it, and intake.ts already imports diagnostician.ts —
// a shared leaf module keeps that from becoming a cycle.
//
// It never triggers anything. FR-035/FR-025 hold by construction: nothing here
// calls `selfHealIntake` or emits a trigger event, so a stuck run can only ever
// annotate the case it already belongs to.

/** What the run-end handler needs to decide the case's next state. */
export interface RunEndVerdict {
  runId?: string;
  /** The detector fired (either condition), and detection is enabled. */
  stuck: boolean;
  reason?: StuckVerdict["reason"];
  /** The run ended on max-steps with detection on — FR-033(b): the case goes
   *  to `stopped` (recoverable by Start), not `failed`. No abort is needed; the
   *  run is already over and its transcript is complete. */
  stopCase: boolean;
  /** The run was killed (by Stop), so the Stop handler owns the case's state. */
  aborted: boolean;
}

export interface RunObserver {
  /** Pass this straight into `runSubAgent`'s `opts.onEvent`. */
  onEvent: (event: SubAgentEvent) => void;
  /** The observed run's id, once `run_started` has arrived. */
  runId: () => string | undefined;
  /** Await every store write the (synchronous) event handler queued. */
  settle: () => Promise<void>;
  /** Record the run's end and classify it. */
  finish: (result: { endedReason?: AgentRunEndedReason; aborted?: boolean; error?: string }) => Promise<RunEndVerdict>;
}

export interface RunObserverInput {
  caseId: string;
  role: CaseRunRole;
  agentId: string;
  agentName?: string;
}

/**
 * Build the observer for one about-to-start run. Async because the detector's
 * threshold and on/off switch come from live config (FR-027) — read once per
 * run, so a mid-run config change cannot make one run's verdict inconsistent
 * with itself.
 */
export async function createRunObserver(input: RunObserverInput): Promise<RunObserver> {
  // Defaults on a read failure rather than an optional chain everywhere: a
  // config the spine cannot read must not silently turn detection off.
  const cfg = await readSelfHealConfig().catch(() => SELF_HEAL_DEFAULTS);
  const detection = cfg.stuckDetector.enabled;
  const detector = new StuckDetector({ repeatCalls: cfg.stuckDetector.repeatCalls });

  let runId: string | undefined;
  // The event handler is synchronous (the agent loop calls it inline), so the
  // store writes it triggers are chained here instead of awaited there —
  // ordered, off the run's critical path, and awaitable via settle().
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (fn: () => Promise<unknown>) => {
    queue = queue.then(fn).then(
      () => undefined,
      (e) => {
        // Observation must never break the run it is observing.
        logger().warn(SELF_HEAL_LOG, `run observation failed for case ${input.caseId}: ${e}`, {});
      },
    );
  };

  const recordStuck = async (verdict: StuckVerdict): Promise<void> => {
    if (!runId) return;
    const signature: StuckSignature = {
      runId,
      reason: verdict.reason ?? "repeat-calls",
      tool: verdict.tool ?? "",
      normalizedInput: verdict.normalizedInput ?? "",
      count: verdict.count ?? 0,
      at: Date.now(),
    };
    const updated = await setStuckSignature(input.caseId, signature);
    if (!updated) return;
    logger().warn(SELF_HEAL_LOG, "run looks stuck", {
      caseId: input.caseId,
      runId,
      reason: signature.reason,
      tool: signature.tool,
      count: String(signature.count),
    });
    // A lifecycle event ON THE CASE — never a trigger. It carries
    // `selfHeal.role`, which the intake's re-entrancy filter drops anyway
    // (FR-035's defense in depth).
    await emitSelfHeal(SELF_HEAL_EVENTS.runStuck, {
      ...casePayload(updated),
      runId,
      stuck: signature,
      summary: summaryFor(
        updated,
        signature.reason === "max-steps"
          ? "looks stuck — the run used its whole step budget"
          : `looks stuck — repeated ${signature.tool} ×${signature.count} with no progress`,
      ),
    });
  };

  const fireIfStuck = () => {
    if (!detection || detector.fired) return;
    const verdict = detector.isStuck();
    if (!verdict.stuck) return;
    detector.markFired();
    enqueue(() => recordStuck(verdict));
  };

  const onEvent = (event: SubAgentEvent) => {
    if ("tool" in event) {
      detector.onToolCall(event.tool, event.input);
      fireIfStuck();
      return;
    }
    if (event.type === "run_started") {
      runId = event.runId;
      enqueue(async () => {
        await appendRun(input.caseId, {
          runId: event.runId,
          agentId: event.agentId || input.agentId,
          ...(input.agentName ? { agentName: input.agentName } : {}),
          role: input.role,
          status: "in-flight",
          startedAt: Date.parse(event.startedAt) || Date.now(),
        });
        await markTranscriptCaseId(event.runId, input.caseId);
      });
      return;
    }
    // A final text is real progress: whatever was being repeated was not a
    // dead end after all.
    if (event.type === "final_text") detector.onProgress();
  };

  const finish: RunObserver["finish"] = async (result) => {
    const verdict = detector.onRunEnd(result.endedReason);
    const stuck = detection && verdict.stuck;
    if (stuck && !detector.fired) {
      detector.markFired();
      await recordStuck(verdict);
    }
    await queue;
    // A run the user stopped can also settle as a plain rejection (the abort
    // unwinds it), so the CASE's own record of the run is consulted too: if the
    // Stop handler already marked this run aborted, that is what happened.
    const recorded = runId ? (await getCase(input.caseId))?.runs?.find((r) => r.runId === runId) : undefined;
    const aborted = result.aborted === true || result.endedReason === "cancelled" || recorded?.status === "aborted";
    const stopCase = detection && result.endedReason === "max_steps";
    const status: CaseRunStatus = aborted
      ? "aborted"
      : stopCase
        ? "stopped"
        : result.error || result.endedReason === "error"
          ? "failed"
          : "completed";
    if (runId) await updateRunStatus(input.caseId, runId, status);
    return {
      ...(runId ? { runId } : {}),
      stuck,
      ...(verdict.reason ? { reason: verdict.reason } : {}),
      stopCase,
      aborted,
    };
  };

  return { onEvent, runId: () => runId, settle: () => queue, finish };
}

/** The case's current in-flight run, if it has one. The Stop handler's "is
 *  there actually anything to kill?" question (R14). */
export async function inFlightRunFor(caseId: string): Promise<{ runId: string; role: CaseRunRole } | undefined> {
  const record = await getCase(caseId);
  const run = [...(record?.runs ?? [])].reverse().find((r) => r.status === "in-flight");
  return run ? { runId: run.runId, role: run.role } : undefined;
}
