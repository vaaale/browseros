import "../services/_stub-server-only";
import { existsSync } from "fs";
import { test, expect } from "@playwright/test";
import * as intake from "../../src/lib/self-heal/intake";
import { storeDiagnosticsReport } from "../../src/lib/self-heal/diagnostician";
import { createCase, getCase, listCases, readIndex, updateCase } from "../../src/lib/self-heal/store";
import { computeFailureSignature } from "../../src/lib/self-heal/signature";
import { _resetRunRegistryForTests, hasRun, registerRun } from "../../src/lib/agent/subagents/run-registry";
import { isTerminalStatus, type TriggerContext } from "../../src/lib/self-heal/types";
import { useSelfHealTestRoot } from "./_test-env";

// 031-self-healing scope-add — the `stopped` state and its two controls
// (FR-018/FR-033(b)/FR-034/FR-035, design ADR-13).
//
// The motivating incident is the whole test list here: a self-heal run loops on
// one tool, the user sees it, presses Stop, and starts it again. So these tests
// pin the observable consequences of Stop and Start — the case's state, the run
// entry's state, the mutual-exclusion slot, the emitted events — plus the two
// things that must NOT happen: a stuck run must not open a new case (FR-035),
// and a stopped case must not be "fixed" by the boot reconcile.

const HARD: TriggerContext = { trigger: "hard-error", toolName: "file_search", errorMessage: "params is not accepted" };
const ALL_ON = { enabled: true, "triggers.hardError": true, "triggers.explicit": true };

async function diagnosedClassE(): Promise<string> {
  const record = await createCase({
    trigger: "hard-error",
    title: "file_grep is missing",
    signature: computeFailureSignature(HARD),
    context: HARD,
  });
  await storeDiagnosticsReport(
    record.id,
    {
      caseId: record.id,
      scopeClass: "e",
      ownership: "bos-core",
      proposedSurface: "src/lib/assistant/tools/server/file-tools.ts",
      verdict: "genuine gap: there is no content-grep tool",
    },
    "## Investigation\n\nThere is no `file_grep`; `file_search` only matches names.",
  );
  return record.id;
}

/** Escalate a diagnosed class-e case to `bs-pipeline` with a run that never
 *  ends, registered in the run registry exactly as a real run would be — so
 *  Stop has something real to kill. */
async function escalateWithLiveRun(runId: string): Promise<{ caseId: string; state: { aborts: number } }> {
  const state = { aborts: 0 };
  intake._setSpineAgentHooksForTests({
    agentAvailable: async () => true,
    runPipeline: async ({ onEvent }) =>
      new Promise((_resolve, reject) => {
        registerRun(runId, {
          agentId: "build-studio",
          abort: () => {
            state.aborts += 1;
            reject(new Error("Cancelled by user"));
          },
        });
        onEvent?.({ type: "run_started", runId, agentId: "build-studio", startedAt: new Date().toISOString() });
      }),
  });
  const caseId = await diagnosedClassE();
  await intake.resolveDiagnosedCase(caseId);
  // The run_started event is recorded through the store's promise chain.
  await expect.poll(async () => (await getCase(caseId))?.runs?.length ?? 0).toBe(1);
  return { caseId, state };
}

test.afterEach(() => {
  intake._setSpineAgentHooksForTests(null);
  _resetRunRegistryForTests();
});

test.describe("Stop (FR-034)", () => {
  test("kills the run, records `stopped`, frees the slot and announces it", async () => {
    const root = useSelfHealTestRoot("stop-live-run");
    _resetRunRegistryForTests();
    try {
      root.writeConfig(ALL_ON);
      const runId = "headless-build-studio-stop-1";
      const { caseId, state } = await escalateWithLiveRun(runId);

      const before = await getCase(caseId);
      expect(before?.status).toBe("bs-pipeline");
      expect(before?.runs?.[0]).toMatchObject({ runId, role: "pipeline", status: "in-flight" });
      expect((await readIndex()).inFlightSlowPathCaseId).toBe(caseId);

      const outcome = await intake.stopRun(caseId);
      expect(outcome).toMatchObject({ ok: true, changed: true });
      expect(state.aborts).toBe(1);
      // The registry entry is gone, so a second Stop has nothing to kill.
      expect(hasRun(runId)).toBe(false);

      const after = await getCase(caseId);
      expect(after?.status).toBe("stopped");
      expect(after?.stoppedFrom).toBe("bs-pipeline");
      expect(after?.runs?.[0].status).toBe("aborted");
      expect(after?.runs?.[0].endedAt).toBeTruthy();
      // `stopped` is NOT terminal — Stop is a pause, not a verdict.
      expect(isTerminalStatus("stopped")).toBe(false);
      // …but it DOES free the slot: a stopped run consumes nothing, and holding
      // the single slot would block every other fix (ADR-13).
      expect((await readIndex()).inFlightSlowPathCaseId).toBeNull();
      expect(after?.timeline.some((t) => t.status === "stopped")).toBe(true);
    } finally {
      await root.cleanup();
    }
  });

  test("the run settling after the kill does not overwrite `stopped` with `failed`", async () => {
    const root = useSelfHealTestRoot("stop-race");
    _resetRunRegistryForTests();
    try {
      root.writeConfig(ALL_ON);
      const { caseId } = await escalateWithLiveRun("headless-build-studio-stop-2");
      await intake.stopRun(caseId);
      // The aborted run's promise rejects, which lands in the run-end handler.
      await new Promise((r) => setTimeout(r, 50));
      expect((await getCase(caseId))?.status).toBe("stopped");
    } finally {
      await root.cleanup();
    }
  });

  test("with no live run it is a no-op that reports the truth (R14)", async () => {
    const root = useSelfHealTestRoot("stop-noop");
    try {
      root.writeConfig(ALL_ON);
      const caseId = await diagnosedClassE();
      // `diagnosed` has no live run to kill.
      const outcome = await intake.stopRun(caseId);
      expect(outcome.ok).toBe(true);
      expect(outcome.changed).toBe(false);
      expect(outcome.reason).toContain("no run is in flight");
      expect((await getCase(caseId))?.status).toBe("diagnosed");

      expect(await intake.stopRun("9999")).toMatchObject({ ok: false, changed: false });
    } finally {
      await root.cleanup();
    }
  });

  test("a case whose run already ended still becomes stoppable-to-`stopped`, truthfully", async () => {
    const root = useSelfHealTestRoot("stop-dead-run");
    _resetRunRegistryForTests();
    try {
      root.writeConfig(ALL_ON);
      const caseId = await diagnosedClassE();
      // In `bs-pipeline` with a recorded in-flight run, but nothing registered:
      // the process restarted, or the run finished between click and handler.
      await updateCase(caseId, { status: "bs-pipeline" });
      const { appendRun } = await import("../../src/lib/self-heal/store");
      await appendRun(caseId, {
        runId: "headless-build-studio-ghost",
        agentId: "build-studio",
        role: "pipeline",
        status: "in-flight",
        startedAt: Date.now(),
      });

      const outcome = await intake.stopRun(caseId);
      expect(outcome.changed).toBe(true);
      expect((await getCase(caseId))?.status).toBe("stopped");
      // The note says what actually happened rather than claiming a kill.
      expect((await getCase(caseId))?.timeline.at(-1)?.note).toContain("no live run");
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("Stop / Start on cases the store only half-remembers", () => {
  test("Stop on an in-flight case with no recorded run still parks it truthfully", async () => {
    const root = useSelfHealTestRoot("stop-no-runs");
    try {
      root.writeConfig(ALL_ON);
      const caseId = await diagnosedClassE();
      // `bs-pipeline` with an EMPTY runs list: the case was escalated by an
      // older revision, or the process died before run_started landed.
      await updateCase(caseId, { status: "bs-pipeline" });

      const outcome = await intake.stopRun(caseId);
      expect(outcome.changed).toBe(true);
      const after = await getCase(caseId);
      expect(after?.status).toBe("stopped");
      expect(after?.timeline.at(-1)?.note).toContain("no live run");
      // Nothing to mark aborted, and nothing invented.
      expect(after?.runs ?? []).toEqual([]);
    } finally {
      await root.cleanup();
    }
  });

  test("Start falls back to the pipeline when the case does not remember what it was doing", async () => {
    const root = useSelfHealTestRoot("start-no-stoppedfrom");
    try {
      root.writeConfig(ALL_ON);
      const briefs: string[] = [];
      const conversations: string[] = [];
      intake._setSpineAgentHooksForTests({
        agentAvailable: async () => true,
        runPipeline: async ({ brief, conversationId }) => {
          briefs.push(brief);
          conversations.push(conversationId);
          return new Promise(() => {});
        },
      });
      const caseId = await diagnosedClassE();
      // `stopped` with no stoppedFrom, no conversation and no branch — the
      // shape a hand-edited or older record can have. The pipeline is the safe
      // default (a diagnosed case's next step), and the conversation id is
      // derived rather than left empty.
      await updateCase(caseId, { status: "stopped" });

      expect((await intake.startRun(caseId)).changed).toBe(true);
      expect((await getCase(caseId))?.status).toBe("bs-pipeline");
      expect(briefs).toHaveLength(1);
      expect(conversations[0]).toBe(intake.pipelineConversationId(caseId));
    } finally {
      await root.cleanup();
    }
  });

  test("a run that reports its own abort leaves the case to the Stop handler", async () => {
    const root = useSelfHealTestRoot("run-reports-aborted");
    try {
      root.writeConfig(ALL_ON);
      intake._setSpineAgentHooksForTests({
        agentAvailable: async () => true,
        // `aborted: true` is the platform's own report that the run was killed
        // (ADR-11) — for a caller that did NOT initiate the abort, this is the
        // only way to know.
        runPipeline: async () => ({ output: "", endedReason: "cancelled", aborted: true }),
      });
      const caseId = await diagnosedClassE();
      await intake.resolveDiagnosedCase(caseId);
      await new Promise((r) => setTimeout(r, 100));
      // Not failed: an abort is not a failure, and whoever aborted owns the
      // case's state.
      expect((await getCase(caseId))?.status).toBe("bs-pipeline");
    } finally {
      await root.cleanup();
    }
  });

  test("a max-steps run that never reported its id is still stopped", async () => {
    const root = useSelfHealTestRoot("maxsteps-no-runid");
    try {
      root.writeConfig(ALL_ON);
      intake._setSpineAgentHooksForTests({
        agentAvailable: async () => true,
        // No run_started: an older/other backend, or a hook that does not
        // forward events. The case still has to end up somewhere sensible.
        runPipeline: async () => ({ output: "", endedReason: "max_steps" }),
      });
      const caseId = await diagnosedClassE();
      await intake.resolveDiagnosedCase(caseId);
      await expect.poll(async () => (await getCase(caseId))?.status, { timeout: 20_000 }).toBe("stopped");
      expect((await getCase(caseId))?.runs ?? []).toEqual([]);
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("Start (FR-034)", () => {
  test("relaunches a FRESH pipeline run, re-claims the slot and announces it", async () => {
    const root = useSelfHealTestRoot("start-pipeline");
    _resetRunRegistryForTests();
    try {
      root.writeConfig(ALL_ON);
      const { caseId } = await escalateWithLiveRun("headless-build-studio-start-1");
      await intake.stopRun(caseId);

      const briefs: string[] = [];
      intake._setSpineAgentHooksForTests({
        agentAvailable: async () => true,
        runPipeline: async ({ brief, onEvent }) => {
          briefs.push(brief);
          onEvent?.({
            type: "run_started",
            runId: "headless-build-studio-start-2",
            agentId: "build-studio",
            startedAt: new Date().toISOString(),
          });
          return new Promise(() => {});
        },
      });

      const outcome = await intake.startRun(caseId);
      expect(outcome).toMatchObject({ ok: true, changed: true });
      const after = await getCase(caseId);
      expect(after?.status).toBe("bs-pipeline");
      expect(after?.stoppedFrom).toBeUndefined();
      expect((await readIndex()).inFlightSlowPathCaseId).toBe(caseId);

      // A FRESH run, from the last committed artifact — not a resume of the
      // killed one. The aborted run stays in the list to read.
      expect(briefs).toHaveLength(1);
      expect(briefs[0]).toContain("STOPPED");
      expect(briefs[0]).toContain("re-reading the pipeline artifacts on disk");
      await expect.poll(async () => (await getCase(caseId))?.runs?.length ?? 0).toBe(2);
      const runs = (await getCase(caseId))!.runs!;
      expect(runs[0].status).toBe("aborted");
      expect(runs[1]).toMatchObject({ runId: "headless-build-studio-start-2", status: "in-flight" });
    } finally {
      await root.cleanup();
    }
  });

  test("Start does not bypass mutual exclusion — it queues behind the holder", async () => {
    const root = useSelfHealTestRoot("start-queues");
    _resetRunRegistryForTests();
    try {
      root.writeConfig(ALL_ON);
      const { caseId } = await escalateWithLiveRun("headless-build-studio-start-3");
      await intake.stopRun(caseId);

      // Another case takes the slot while this one is stopped.
      const other = await diagnosedClassE();
      const { claimInFlightSlot } = await import("../../src/lib/self-heal/store");
      await claimInFlightSlot(other);

      const outcome = await intake.startRun(caseId);
      expect(outcome.changed).toBe(true);
      expect((await getCase(caseId))?.status).toBe("queued-slow");
      expect((await readIndex()).slowQueue.map((e) => e.caseId)).toContain(caseId);
    } finally {
      await root.cleanup();
    }
  });

  test("a stopped Diagnostician restarts the Diagnostician, not the pipeline", async () => {
    const root = useSelfHealTestRoot("start-diagnostician");
    try {
      root.writeConfig(ALL_ON);
      const diagnosed: string[] = [];
      intake._setSpineAgentHooksForTests({ diagnose: async (id) => { diagnosed.push(id); return { ok: true }; } });
      const caseId = await diagnosedClassE();
      await updateCase(caseId, { status: "stopped", stoppedFrom: "diagnosing" });

      const outcome = await intake.startRun(caseId);
      expect(outcome.changed).toBe(true);
      expect((await getCase(caseId))?.status).toBe("diagnosing");
      await expect.poll(() => diagnosed).toEqual([caseId]);
    } finally {
      await root.cleanup();
    }
  });

  test("Start on a case that is not stopped is a no-op that reports the truth", async () => {
    const root = useSelfHealTestRoot("start-noop");
    try {
      root.writeConfig(ALL_ON);
      const caseId = await diagnosedClassE();
      const outcome = await intake.startRun(caseId);
      expect(outcome).toMatchObject({ ok: true, changed: false });
      expect(outcome.reason).toContain("not stopped");
      expect((await getCase(caseId))?.status).toBe("diagnosed");

      expect(await intake.startRun("9999")).toMatchObject({ ok: false, changed: false });
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("max-steps → stopped (FR-033(b), M1)", () => {
  test("a pipeline run that exhausts its step budget is stopped, not failed", async () => {
    const root = useSelfHealTestRoot("maxsteps-stopped");
    try {
      root.writeConfig(ALL_ON);
      intake._setSpineAgentHooksForTests({
        agentAvailable: async () => true,
        runPipeline: async ({ onEvent }) => {
          onEvent?.({
            type: "run_started",
            runId: "headless-build-studio-maxsteps",
            agentId: "build-studio",
            startedAt: new Date().toISOString(),
          });
          // The loop's own end reason, surfaced by runLocalHeadless. Before the
          // scope-add this arrived as an indistinguishable clean return and the
          // case was marked `failed` — terminal and silent about why.
          return { output: "", endedReason: "max_steps" };
        },
      });
      const caseId = await diagnosedClassE();
      await intake.resolveDiagnosedCase(caseId);

      await expect.poll(async () => (await getCase(caseId))?.status, { timeout: 20_000 }).toBe("stopped");
      const after = await getCase(caseId);
      expect(after?.stoppedFrom).toBe("bs-pipeline");
      expect(after?.runs?.[0].status).toBe("stopped");
      expect(after?.error).toBeUndefined();
      // The slot is freed, so the queue keeps moving.
      expect((await readIndex()).inFlightSlowPathCaseId).toBeNull();
      // …and Start can pick it right back up.
      expect((await intake.startRun(caseId)).changed).toBe(true);
    } finally {
      await root.cleanup();
    }
  });

  test("a clean run that reported no fix is still `failed` — that path is unchanged", async () => {
    const root = useSelfHealTestRoot("completed-failed");
    try {
      root.writeConfig(ALL_ON);
      intake._setSpineAgentHooksForTests({
        agentAvailable: async () => true,
        runPipeline: async () => ({ output: "I had a look but did not finish", endedReason: "completed" }),
      });
      const caseId = await diagnosedClassE();
      await intake.resolveDiagnosedCase(caseId);
      await expect.poll(async () => (await getCase(caseId))?.status, { timeout: 20_000 }).toBe("failed");
    } finally {
      await root.cleanup();
    }
  });

  test("with the detector off, a max-steps run takes the old `failed` path", async () => {
    const root = useSelfHealTestRoot("maxsteps-detector-off");
    try {
      root.writeConfig({ ...ALL_ON, "stuckDetector.enabled": false });
      intake._setSpineAgentHooksForTests({
        agentAvailable: async () => true,
        runPipeline: async () => ({ output: "", endedReason: "max_steps" }),
      });
      const caseId = await diagnosedClassE();
      await intake.resolveDiagnosedCase(caseId);
      await expect.poll(async () => (await getCase(caseId))?.status, { timeout: 20_000 }).toBe("failed");
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("the stuck detector, through the spine (FR-033/FR-035)", () => {
  test("a looping run flags its case and emits run_stuck — and creates NO new case", async () => {
    const root = useSelfHealTestRoot("stuck-flags-case");
    try {
      root.writeConfig({ ...ALL_ON, "stuckDetector.repeatCalls": 3 });
      intake._setSpineAgentHooksForTests({
        agentAvailable: async () => true,
        runPipeline: async ({ onEvent }) => {
          onEvent?.({
            type: "run_started",
            runId: "headless-build-studio-loop",
            agentId: "build-studio",
            startedAt: new Date().toISOString(),
          });
          // The incident, exactly: the same call, over and over.
          for (let i = 0; i < 4; i++) onEvent?.({ tool: "file_search", input: { dir: "src", query: "file_read" } });
          return new Promise(() => {});
        },
      });
      const caseId = await diagnosedClassE();
      const casesBefore = (await listCases()).length;
      await intake.resolveDiagnosedCase(caseId);

      await expect.poll(async () => (await getCase(caseId))?.stuckSignature?.tool, { timeout: 20_000 }).toBe("file_search");
      const after = await getCase(caseId);
      expect(after?.stuckSignature).toMatchObject({ reason: "repeat-calls", runId: "headless-build-studio-loop" });
      expect(after?.stuckSignature!.count).toBeGreaterThanOrEqual(3);
      expect(after?.runs?.[0].stuck?.tool).toBe("file_search");
      // The run keeps going — being flagged is not being killed. The ONLY
      // remedy is the user's Stop/Start.
      expect(after?.status).toBe("bs-pipeline");

      // FR-035/FR-025: a stuck self-heal run must NOT open a new self-heal
      // case. Nothing in the detector path can — it never reaches the intake.
      expect((await listCases()).length).toBe(casesBefore);
    } finally {
      await root.cleanup();
    }
  });

  test("with the detector off nothing is flagged", async () => {
    const root = useSelfHealTestRoot("stuck-detector-off");
    try {
      root.writeConfig({ ...ALL_ON, "stuckDetector.enabled": false });
      intake._setSpineAgentHooksForTests({
        agentAvailable: async () => true,
        runPipeline: async ({ onEvent }) => {
          onEvent?.({
            type: "run_started",
            runId: "headless-build-studio-loop-off",
            agentId: "build-studio",
            startedAt: new Date().toISOString(),
          });
          for (let i = 0; i < 8; i++) onEvent?.({ tool: "file_search", input: { dir: "src" } });
          return new Promise(() => {});
        },
      });
      const caseId = await diagnosedClassE();
      await intake.resolveDiagnosedCase(caseId);
      await expect.poll(async () => (await getCase(caseId))?.runs?.length ?? 0, { timeout: 20_000 }).toBe(1);
      expect((await getCase(caseId))?.stuckSignature).toBeUndefined();
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("the run observer itself (ADR-12)", () => {
  test("records the run, stamps the transcript, and reports how it ended", async () => {
    const root = useSelfHealTestRoot("observer-basics");
    try {
      root.writeConfig(ALL_ON);
      const { createRunObserver, inFlightRunFor } = await import("../../src/lib/self-heal/runs");
      const { TranscriptionWriter, readTranscript } = await import("../../src/lib/agent/subagents/transcript");
      const caseId = await diagnosedClassE();

      // A real transcript for the run, so the caseId stamp has something to
      // write to (that is the whole point of the stamp — ADR-10).
      const transcript = new TranscriptionWriter();
      await transcript.open("conversation-reviewer", "headless-observed-1", "diagnose it");

      const observer = await createRunObserver({
        caseId,
        role: "diagnostician",
        agentId: "conversation-reviewer",
        agentName: "Conversation Reviewer",
      });
      expect(observer.runId()).toBeUndefined();
      observer.onEvent({
        type: "run_started",
        runId: "headless-observed-1",
        agentId: "conversation-reviewer",
        startedAt: "not a date",
      });
      expect(observer.runId()).toBe("headless-observed-1");
      // Events the observer does not care about are ignored, not mishandled.
      observer.onEvent({ type: "tool_result", name: "file_read", result: "ok", ok: true });
      observer.onEvent({ type: "reasoning_delta", delta: "thinking" });
      observer.onEvent({ type: "final_text", text: "done" });
      await observer.settle();

      const run = await inFlightRunFor(caseId);
      expect(run).toMatchObject({ runId: "headless-observed-1", role: "diagnostician" });
      // An unparseable startedAt still yields a usable timestamp.
      expect((await getCase(caseId))?.runs?.[0].startedAt).toBeGreaterThan(0);
      expect((await readTranscript("headless-observed-1"))?.caseId).toBe(caseId);

      const verdict = await observer.finish({ endedReason: "completed" });
      expect(verdict).toMatchObject({ stuck: false, stopCase: false, aborted: false });
      expect((await getCase(caseId))?.runs?.[0].status).toBe("completed");
      expect(await inFlightRunFor(caseId)).toBeUndefined();
    } finally {
      await root.cleanup();
    }
  });

  test("an errored run is recorded failed; a cancelled one aborted", async () => {
    const root = useSelfHealTestRoot("observer-endings");
    try {
      root.writeConfig(ALL_ON);
      const { createRunObserver } = await import("../../src/lib/self-heal/runs");
      const caseId = await diagnosedClassE();

      const failed = await createRunObserver({ caseId, role: "pipeline", agentId: "build-studio" });
      failed.onEvent({ type: "run_started", runId: "run-failed", agentId: "build-studio", startedAt: new Date().toISOString() });
      await failed.settle();
      expect(await failed.finish({ endedReason: "error", error: "boom" })).toMatchObject({ aborted: false });
      expect((await getCase(caseId))?.runs?.find((r) => r.runId === "run-failed")?.status).toBe("failed");

      const cancelled = await createRunObserver({ caseId, role: "pipeline", agentId: "build-studio" });
      cancelled.onEvent({ type: "run_started", runId: "run-cancelled", agentId: "build-studio", startedAt: new Date().toISOString() });
      await cancelled.settle();
      expect(await cancelled.finish({ endedReason: "cancelled" })).toMatchObject({ aborted: true });
      expect((await getCase(caseId))?.runs?.find((r) => r.runId === "run-cancelled")?.status).toBe("aborted");
    } finally {
      await root.cleanup();
    }
  });

  test("a run that never reported run_started is still classifiable", async () => {
    const root = useSelfHealTestRoot("observer-no-start");
    try {
      root.writeConfig(ALL_ON);
      const { createRunObserver } = await import("../../src/lib/self-heal/runs");
      const caseId = await diagnosedClassE();
      const observer = await createRunObserver({ caseId, role: "pipeline", agentId: "build-studio" });
      // A hook override (or a refusal that never started a run) means no
      // run_started ever arrives: there is nothing to record, and nothing to
      // announce, but finish() must still answer.
      observer.onEvent({ tool: "file_search", input: { q: "a" } });
      const verdict = await observer.finish({ endedReason: "max_steps" });
      expect(verdict).toMatchObject({ stuck: true, stopCase: true });
      expect(verdict.runId).toBeUndefined();
      expect((await getCase(caseId))?.runs ?? []).toEqual([]);
      expect((await getCase(caseId))?.stuckSignature).toBeUndefined();
    } finally {
      await root.cleanup();
    }
  });

  test("observing a case that has vanished does not throw", async () => {
    const root = useSelfHealTestRoot("observer-missing-case");
    try {
      root.writeConfig(ALL_ON);
      const { createRunObserver } = await import("../../src/lib/self-heal/runs");
      const observer = await createRunObserver({ caseId: "9999", role: "pipeline", agentId: "build-studio" });
      observer.onEvent({ type: "run_started", runId: "run-ghost", agentId: "build-studio", startedAt: new Date().toISOString() });
      for (let i = 0; i < 6; i++) observer.onEvent({ tool: "file_search", input: { q: "a" } });
      await observer.settle();
      expect(await observer.finish({ endedReason: "completed" })).toMatchObject({ stuck: true });
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("the store's run helpers", () => {
  test("run writes against a missing case or a missing run are no-ops", async () => {
    const root = useSelfHealTestRoot("store-run-helpers");
    try {
      root.writeConfig(ALL_ON);
      const store = await import("../../src/lib/self-heal/store");
      const run = {
        runId: "r1",
        agentId: "build-studio",
        role: "pipeline" as const,
        status: "in-flight" as const,
        startedAt: Date.now(),
      };
      expect(await store.appendRun("9999", run)).toBeUndefined();
      expect(await store.updateRunStatus("9999", "r1", "completed")).toBeUndefined();
      expect(
        await store.setStuckSignature("9999", { runId: "r1", reason: "max-steps", tool: "", normalizedInput: "", count: 0, at: Date.now() }),
      ).toBeUndefined();
      expect(await store.listCaseRuns("9999")).toEqual([]);

      const caseId = await diagnosedClassE();
      await store.appendRun(caseId, run);
      // Re-appending the same runId updates in place rather than duplicating —
      // a redelivered run_started must not double-list a run.
      await store.appendRun(caseId, { ...run, agentName: "Build Studio" });
      expect((await store.listCaseRuns(caseId))).toHaveLength(1);
      expect((await store.listCaseRuns(caseId))[0].agentName).toBe("Build Studio");

      // A status for a run this case never had leaves the case alone.
      const untouched = await store.updateRunStatus(caseId, "nope", "failed");
      expect(untouched?.runs?.[0].status).toBe("in-flight");

      // A stuck signature for an unlisted run still records on the CASE (the
      // case-level flag is what the UI reads).
      await store.setStuckSignature(caseId, {
        runId: "nope",
        reason: "repeat-calls",
        tool: "file_search",
        normalizedInput: "q=a",
        count: 5,
        at: Date.now(),
      });
      expect((await getCase(caseId))?.stuckSignature?.tool).toBe("file_search");
      expect((await store.listCaseRuns(caseId))[0].stuck).toBeUndefined();

      // Releasing a slot another case holds must not steal it.
      await store.claimInFlightSlot("0002");
      await store.releaseInFlightSlot(caseId);
      expect((await readIndex()).inFlightSlowPathCaseId).toBe("0002");
      await store.releaseInFlightSlot("0002");
      expect((await readIndex()).inFlightSlowPathCaseId).toBeNull();
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("the restart brief (FR-034)", () => {
  test("names the stuck call so the fresh run does not walk into the same loop", async () => {
    const root = useSelfHealTestRoot("restart-brief");
    try {
      root.writeConfig(ALL_ON);
      const { buildRestartBrief } = await import("../../src/lib/self-heal/brief");
      const caseId = await diagnosedClassE();
      const plain = buildRestartBrief((await getCase(caseId))!);
      expect(plain).toContain("STOPPED");
      expect(plain).not.toContain("Do NOT repeat that call");

      await updateCase(caseId, {
        activeFeatureBranch: `bos/self-heal-${caseId}`,
        stuckSignature: {
          runId: "headless-build-studio-loop",
          reason: "repeat-calls",
          tool: "file_search",
          normalizedInput: "dir=src&query=file_read",
          count: 5,
          at: Date.now(),
        },
      });
      const informed = buildRestartBrief((await getCase(caseId))!);
      expect(informed).toContain("file_search");
      expect(informed).toContain("5 times");
      expect(informed).toContain("Do NOT repeat that call");
      expect(informed).toContain(`bos/self-heal-${caseId}`);
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("Discard (FR-036)", () => {
  test("on an in-flight case: kills the run, deletes the record, frees the slot, announces it — and keeps the transcript", async () => {
    const root = useSelfHealTestRoot("discard-in-flight");
    _resetRunRegistryForTests();
    try {
      root.writeConfig(ALL_ON);
      const runId = "headless-build-studio-discard-1";
      const { caseId, state } = await escalateWithLiveRun(runId);

      // A real transcript for the run — discarding the CASE must not touch it
      // (transcripts are platform artifacts owned by the run layer).
      const { TranscriptionWriter, transcriptPathFor } = await import("../../src/lib/agent/subagents/transcript");
      const transcript = new TranscriptionWriter();
      await transcript.open("build-studio", runId, "fix it");
      const transcriptFile = transcriptPathFor("build-studio", runId);
      expect(existsSync(transcriptFile)).toBe(true);

      expect((await readIndex()).inFlightSlowPathCaseId).toBe(caseId);
      // The events store is a process-wide singleton, so counts are deltas.
      const api = await import("../../src/lib/events/api");
      const emittedBefore = api.query({ type: "com.bos.self-heal.case_discarded" }).events.length;

      const outcome = await intake.discardCase(caseId);
      expect(outcome).toMatchObject({ ok: true, discarded: true });

      // The run was aborted, the record is gone (file AND index), the slot is free.
      expect(state.aborts).toBe(1);
      expect(await getCase(caseId)).toBeUndefined();
      const index = await readIndex();
      expect(index.cases[caseId]).toBeUndefined();
      expect(index.inFlightSlowPathCaseId).toBeNull();

      // Announced: the event is the only remaining trace of the case.
      const events = api.query({ type: "com.bos.self-heal.case_discarded" }).events;
      expect(events).toHaveLength(emittedBefore + 1);
      const full = await api.getEvent(events[0].id);
      expect(full.payload).toMatchObject({ caseId, status: "bs-pipeline", trigger: "hard-error" });

      // The transcript file survives the discard.
      expect(existsSync(transcriptFile)).toBe(true);
    } finally {
      await root.cleanup();
    }
  });

  test("on a case with no live run: deletes the record and announces it, aborting nothing", async () => {
    const root = useSelfHealTestRoot("discard-completed");
    _resetRunRegistryForTests();
    try {
      root.writeConfig(ALL_ON);
      const caseId = await diagnosedClassE();
      const api = await import("../../src/lib/events/api");
      const emittedBefore = api.query({ type: "com.bos.self-heal.case_discarded" }).events.length;

      const outcome = await intake.discardCase(caseId);
      expect(outcome).toMatchObject({ ok: true, discarded: true });
      expect(await getCase(caseId)).toBeUndefined();
      expect((await readIndex()).cases[caseId]).toBeUndefined();

      const events = api.query({ type: "com.bos.self-heal.case_discarded" }).events;
      expect(events).toHaveLength(emittedBefore + 1);
      expect((await api.getEvent(events[0].id)).payload).toMatchObject({ caseId, status: "diagnosed" });
    } finally {
      await root.cleanup();
    }
  });

  test("on a case that does not exist it is a no-op — nothing deleted, nothing announced", async () => {
    const root = useSelfHealTestRoot("discard-missing");
    try {
      root.writeConfig(ALL_ON);
      const api = await import("../../src/lib/events/api");
      const emittedBefore = api.query({ type: "com.bos.self-heal.case_discarded" }).events.length;
      const outcome = await intake.discardCase("9999");
      expect(outcome).toMatchObject({ ok: true, discarded: false });
      expect(api.query({ type: "com.bos.self-heal.case_discarded" }).events).toHaveLength(emittedBefore);
      // The store-level delete is equally a no-op on a missing case.
      const { deleteCase } = await import("../../src/lib/self-heal/store");
      expect(await deleteCase("9999")).toBe(false);
    } finally {
      await root.cleanup();
    }
  });

  test("discarding the dedupe holder lets the same failure open a fresh case", async () => {
    const root = useSelfHealTestRoot("discard-dedupe");
    try {
      root.writeConfig(ALL_ON);
      intake._setSpineAgentHooksForTests({ diagnose: async () => ({ ok: false }) });
      const first = await intake.selfHealIntake(HARD);
      expect(first.action).toBe("created");
      const caseId = (first as { caseId: string }).caseId;

      await intake.discardCase(caseId);
      // "Cannot be undone" also means "no ghost dedupe entry": a discarded
      // case must not keep suppressing the failure it was opened for.
      const again = await intake.selfHealIntake(HARD);
      expect(again.action).toBe("created");
      expect((again as { caseId: string }).caseId).not.toBe(caseId);
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("boot reconcile leaves a stopped case alone", () => {
  test("a stopped case is the user's paused state, not something to recover", async () => {
    const root = useSelfHealTestRoot("reconcile-stopped");
    try {
      root.writeConfig(ALL_ON);
      const caseId = await diagnosedClassE();
      await updateCase(caseId, { status: "stopped", stoppedFrom: "bs-pipeline" });

      const summary = await intake.reconcileInFlightCases();
      expect(summary.failed).not.toContain(caseId);
      expect(summary.fixReadyEmitted).not.toContain(caseId);
      expect((await getCase(caseId))?.status).toBe("stopped");
    } finally {
      await root.cleanup();
    }
  });
});
