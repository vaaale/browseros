import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import * as intake from "../../src/lib/self-heal/intake";
import { getCase, listCases, readIndex, updateCase, withIndex } from "../../src/lib/self-heal/store";
import { storeDiagnosticsReport } from "../../src/lib/self-heal/diagnostician";
import { useSelfHealTestRoot } from "./_test-env";
import type { ScopeClass, TriggerContext } from "../../src/lib/self-heal/types";

// 031-self-healing — the fast spine's decision tree (design ADR-1).
//
// Phase A: guards → re-entrancy → allowlist → dedupe → cost cap → create.
// Phase B: the scope-class router, the ownership override, and the single
// pipeline slot.
//
// The two LLM launches are replaced through `_setSpineAgentHooksForTests`, so
// what is under test here is exactly the deterministic part — which is the part
// that decides whether BOS spends tokens and whether it touches code.

const HARD: TriggerContext = {
  trigger: "hard-error",
  toolName: "file_read",
  errorMessage: "permission denied reading /Documents/x.md",
};

const ALL_TRIGGERS_ON = {
  enabled: true,
  "triggers.explicit": true,
  "triggers.hardError": true,
  "triggers.repeatedFailure": true,
  "triggers.workflowTimeout": true,
  "triggers.logEvents": true,
};

/** Stub both agent seams; `diagnosed` decides what the Diagnostician "found". */
function stubHooks(opts: {
  diagnosis?: { scopeClass: ScopeClass; ownership: string; proposedSurface: string; appId?: string } | "fail";
  pipelineRuns?: string[];
} = {}) {
  const pipelineRuns = opts.pipelineRuns ?? [];
  intake._setSpineAgentHooksForTests({
    diagnose: async (caseId) => {
      if (opts.diagnosis === "fail" || !opts.diagnosis) {
        await updateCase(caseId, { status: "failed", error: "stubbed failure" });
        return { ok: false, error: "stubbed failure" };
      }
      await storeDiagnosticsReport(
        caseId,
        {
          caseId,
          scopeClass: opts.diagnosis.scopeClass,
          ownership: opts.diagnosis.ownership as never,
          proposedSurface: opts.diagnosis.proposedSurface,
          ...(opts.diagnosis.appId ? { appId: opts.diagnosis.appId } : {}),
          verdict: "genuine gap: stubbed",
        },
        "## Investigation\n\nSee `src/lib/self-heal/intake.ts:1`.",
      );
      return { ok: true };
    },
    agentAvailable: async () => true,
    // Never resolves: keeps the case parked in `bs-pipeline` so the slot
    // behaviour is observable, exactly like a real multi-hour run.
    runPipeline: async (input) => {
      pipelineRuns.push(input.caseId);
      return new Promise(() => {});
    },
  });
  return pipelineRuns;
}

test.afterEach(() => {
  intake._setSpineAgentHooksForTests(null);
});

// ── Phase A: the guards ─────────────────────────────────────────────────────

test.describe("intake guards", () => {
  test("the kill switch stops everything before a case or a token (SC-006)", async () => {
    const root = useSelfHealTestRoot("intake-disabled");
    try {
      root.writeConfig({ ...ALL_TRIGGERS_ON, enabled: false });
      stubHooks();
      const outcome = await intake.selfHealIntake(HARD, { awaitDiagnosis: true });
      expect(outcome.action).toBe("disabled");
      expect(await listCases()).toEqual([]);
    } finally {
      await root.cleanup();
    }
  });

  test("a per-trigger toggle blocks only its own trigger (FR-006)", async () => {
    const root = useSelfHealTestRoot("intake-trigger-off");
    try {
      root.writeConfig({ enabled: true, "triggers.hardError": false, "triggers.explicit": true });
      stubHooks({ diagnosis: { scopeClass: "a", ownership: "env", proposedSurface: "the network" } });

      const blocked = await intake.selfHealIntake(HARD, { awaitDiagnosis: true });
      expect(blocked.action).toBe("trigger-disabled");
      expect(await listCases()).toEqual([]);

      // The explicit trigger still works.
      const allowed = await intake.selfHealIntake({ trigger: "explicit", description: "x is broken" }, { awaitDiagnosis: true });
      expect(allowed.action).toBe("created");
    } finally {
      await root.cleanup();
    }
  });

  test("an environmental error creates NO case and spends NO tokens (SC-003)", async () => {
    const root = useSelfHealTestRoot("intake-env");
    try {
      root.writeConfig(ALL_TRIGGERS_ON);
      stubHooks({ diagnosis: { scopeClass: "e", ownership: "bos-core", proposedSurface: "x" } });
      const outcome = await intake.selfHealIntake(
        { trigger: "hard-error", toolName: "web_fetch", errorMessage: "getaddrinfo ENOTFOUND api.example.com" },
        { awaitDiagnosis: true },
      );
      expect(outcome.action).toBe("environmental");
      expect(await listCases()).toEqual([]);
      expect((await readIndex()).ledger).toEqual([]);
    } finally {
      await root.cleanup();
    }
  });

  test("a log event from a non-BOS component is refused (FR-005)", async () => {
    const root = useSelfHealTestRoot("intake-not-owned");
    try {
      root.writeConfig(ALL_TRIGGERS_ON);
      stubHooks();
      const outcome = await intake.selfHealIntake(
        { trigger: "log-events", component: "okf-knowledge-base", errorMessage: "index rebuild failed" },
        { awaitDiagnosis: true },
      );
      expect(outcome.action).toBe("not-bos-owned");
      expect(await listCases()).toEqual([]);
    } finally {
      await root.cleanup();
    }
  });

  test("an event carrying a selfHeal role marker never re-enters (FR-025 guard b)", async () => {
    const root = useSelfHealTestRoot("intake-reentrancy-payload");
    try {
      root.writeConfig(ALL_TRIGGERS_ON);
      stubHooks();
      const outcome = await intake.selfHealIntake(HARD, {
        awaitDiagnosis: true,
        eventPayload: { caseId: "0001", selfHeal: { role: "lifecycle", caseId: "0001" } },
      });
      expect(outcome.action).toBe("reentrancy-skipped");
      expect(await listCases()).toEqual([]);
    } finally {
      await root.cleanup();
    }
  });
});

// ── Phase A: dedupe + cost cap ──────────────────────────────────────────────

test.describe("dedupe (FR-019 / SC-007)", () => {
  test("the same signature inside the window creates ONE case", async () => {
    const root = useSelfHealTestRoot("intake-dedupe");
    try {
      root.writeConfig({ ...ALL_TRIGGERS_ON, dedupeWindowSec: 86_400 });
      stubHooks({ diagnosis: { scopeClass: "a", ownership: "env", proposedSurface: "disk" } });

      const first = await intake.selfHealIntake(HARD, { awaitDiagnosis: true });
      expect(first.action).toBe("created");
      const second = await intake.selfHealIntake(HARD, { awaitDiagnosis: true });
      expect(second.action).toBe("duplicate");
      if (second.action === "duplicate" && first.action === "created") {
        expect(second.originalCaseId).toBe(first.caseId);
      }
      expect(await listCases()).toHaveLength(1);
    } finally {
      await root.cleanup();
    }
  });

  test("once the window has passed, the same signature becomes a NEW case", async () => {
    const root = useSelfHealTestRoot("intake-dedupe-expired");
    try {
      root.writeConfig({ ...ALL_TRIGGERS_ON, dedupeWindowSec: 60 });
      stubHooks({ diagnosis: { scopeClass: "a", ownership: "env", proposedSurface: "disk" } });
      await intake.selfHealIntake(HARD, { awaitDiagnosis: true });
      // Back-date the dedupe entry past the window.
      await withIndex((index) => {
        for (const key of Object.keys(index.dedupe)) index.dedupe[key].at = Date.now() - 120_000;
      });
      const second = await intake.selfHealIntake(HARD, { awaitDiagnosis: true });
      expect(second.action).toBe("created");
      expect(await listCases()).toHaveLength(2);
    } finally {
      await root.cleanup();
    }
  });

  test("a dedupe window of 0 disables suppression entirely", async () => {
    const root = useSelfHealTestRoot("intake-dedupe-zero");
    try {
      root.writeConfig({ ...ALL_TRIGGERS_ON, dedupeWindowSec: 0 });
      stubHooks({ diagnosis: { scopeClass: "a", ownership: "env", proposedSurface: "disk" } });
      await intake.selfHealIntake(HARD, { awaitDiagnosis: true });
      const second = await intake.selfHealIntake(HARD, { awaitDiagnosis: true });
      expect(second.action).toBe("created");
    } finally {
      await root.cleanup();
    }
  });

  test("two DIFFERENT signatures are never deduped against each other", async () => {
    const root = useSelfHealTestRoot("intake-dedupe-distinct");
    try {
      root.writeConfig(ALL_TRIGGERS_ON);
      stubHooks({ diagnosis: { scopeClass: "a", ownership: "env", proposedSurface: "disk" } });
      await intake.selfHealIntake(HARD, { awaitDiagnosis: true });
      const other = await intake.selfHealIntake(
        { trigger: "hard-error", toolName: "file_write", errorMessage: "permission denied writing /Documents/x.md" },
        { awaitDiagnosis: true },
      );
      expect(other.action).toBe("created");
      expect(await listCases()).toHaveLength(2);
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("the cost cap (FR-020)", () => {
  test("over budget, a trigger is QUEUED — never dropped", async () => {
    const root = useSelfHealTestRoot("intake-capped");
    try {
      root.writeConfig({ ...ALL_TRIGGERS_ON, costCapPerDay: 10 });
      const runs = stubHooks({ diagnosis: { scopeClass: "e", ownership: "bos-core", proposedSurface: "x" } });
      await withIndex((index) => {
        index.ledger.push({ caseId: "prior", role: "pipeline", tokens: 50, at: Date.now() });
      });

      const outcome = await intake.selfHealIntake(HARD, { awaitDiagnosis: true });
      expect(outcome.action).toBe("queued-cost");
      const cases = await listCases();
      expect(cases).toHaveLength(1);
      expect(cases[0].status).toBe("queued-cost");
      expect((await readIndex()).costQueue.map((e) => e.caseId)).toEqual([cases[0].id]);
      // Crucially: no Diagnostician run, so no tokens.
      expect(runs).toEqual([]);
    } finally {
      await root.cleanup();
    }
  });
});

// ── Phase B: the scope-class router ─────────────────────────────────────────

async function diagnoseAs(
  scopeClass: ScopeClass,
  ownership: string,
  proposedSurface: string,
  extra: Partial<TriggerContext> = {},
) {
  stubHooks({ diagnosis: { scopeClass, ownership, proposedSurface } });
  const outcome = await intake.selfHealIntake({ ...HARD, ...extra }, { awaitDiagnosis: true });
  if (outcome.action !== "created") throw new Error(`expected a case, got ${outcome.action}`);
  return outcome.caseId;
}

test.describe("scope-class routing", () => {
  test("class a closes as env-only with no durable change (FR-009)", async () => {
    const root = useSelfHealTestRoot("route-a");
    try {
      root.writeConfig(ALL_TRIGGERS_ON);
      const caseId = await diagnoseAs("a", "env", "the user's disk permissions");
      const record = await getCase(caseId);
      expect(record?.status).toBe("env-only");
      expect(record?.scopeClass).toBe("a");
    } finally {
      await root.cleanup();
    }
  });

  test("class b parks for consent (FR-010)", async () => {
    const root = useSelfHealTestRoot("route-b");
    try {
      root.writeConfig(ALL_TRIGGERS_ON);
      const caseId = await diagnoseAs("b", "bos-core", "agent-behavior-review");
      expect((await getCase(caseId))?.status).toBe("awaiting-consent");
    } finally {
      await root.cleanup();
    }
  });

  test("class c parks for consent (FR-011)", async () => {
    const root = useSelfHealTestRoot("route-c");
    try {
      root.writeConfig(ALL_TRIGGERS_ON);
      const caseId = await diagnoseAs("c", "workflow", "/Workflows/daily-review.json");
      expect((await getCase(caseId))?.status).toBe("awaiting-consent");
    } finally {
      await root.cleanup();
    }
  });

  test("class d notifies only and never attempts a modification (FR-012 / SC-005)", async () => {
    const root = useSelfHealTestRoot("route-d");
    try {
      root.writeConfig(ALL_TRIGGERS_ON);
      const caseId = await diagnoseAs("d", "marketplace", "some-marketplace-app");
      const record = await getCase(caseId);
      expect(record?.status).toBe("notified");
      expect(record?.scopeClass).toBe("d");
      // Notify-only means the slow path was never entered.
      expect((await readIndex()).inFlightSlowPathCaseId).toBeNull();
    } finally {
      await root.cleanup();
    }
  });

  test("a d-bis diagnosis for an app that is NOT actually owned is corrected to d", async () => {
    const root = useSelfHealTestRoot("route-dbis-override");
    try {
      root.writeConfig(ALL_TRIGGERS_ON);
      // Nothing is installed in this temp data dir, so the server-side
      // ownership check finds no local item and overrides the Diagnostician's
      // (advisory) d-bis call — design §5's authoritative predicate.
      const caseId = await diagnoseAs("d-bis", "user-app", "okf-knowledge-base/src/service.ts");
      const record = await getCase(caseId);
      expect(record?.scopeClass).toBe("d");
      expect(record?.status).toBe("notified");
      expect(record?.timeline.some((t) => (t.note ?? "").includes("not present in data/user-apps"))).toBe(true);
    } finally {
      await root.cleanup();
    }
  });

  test("class e escalates to the pipeline with the branch pre-set (FR-015b)", async () => {
    const root = useSelfHealTestRoot("route-e");
    try {
      root.writeConfig(ALL_TRIGGERS_ON);
      const caseId = await diagnoseAs("e", "bos-core", "src/lib/assistant/tools/frontend-declarations.ts");
      const record = await getCase(caseId);
      expect(record?.status).toBe("bs-pipeline");
      expect(record?.activeFeatureBranch).toBe(`bos/self-heal-${caseId}`);
      expect(record?.conversationId).toBe(`c-self-heal-fix-${caseId}`);
      expect((await readIndex()).inFlightSlowPathCaseId).toBe(caseId);
    } finally {
      await root.cleanup();
    }
  });

  test("with autonomous implement OFF, a class-e case waits for the user instead", async () => {
    const root = useSelfHealTestRoot("route-e-not-autonomous");
    try {
      root.writeConfig({ ...ALL_TRIGGERS_ON, autonomousImplement: false });
      const caseId = await diagnoseAs("e", "bos-core", "src/lib/x.ts");
      const record = await getCase(caseId);
      expect(record?.status).toBe("awaiting-consent");
      // And it is not squatting on the pipeline slot while it waits.
      expect((await readIndex()).inFlightSlowPathCaseId).toBeNull();
    } finally {
      await root.cleanup();
    }
  });

  test("a failed diagnosis leaves the case failed and routes nothing", async () => {
    const root = useSelfHealTestRoot("route-diagnosis-failed");
    try {
      root.writeConfig(ALL_TRIGGERS_ON);
      stubHooks({ diagnosis: "fail" });
      const outcome = await intake.selfHealIntake(HARD, { awaitDiagnosis: true });
      if (outcome.action !== "created") throw new Error("expected a case");
      expect((await getCase(outcome.caseId))?.status).toBe("failed");
    } finally {
      await root.cleanup();
    }
  });

  test("resolving an undiagnosed or terminal case is a no-op, not an error", async () => {
    const root = useSelfHealTestRoot("route-noop");
    try {
      root.writeConfig(ALL_TRIGGERS_ON);
      expect((await intake.resolveDiagnosedCase("nope")).action).toBe("skipped");
      const caseId = await diagnoseAs("a", "env", "disk");
      // Already terminal.
      expect((await intake.resolveDiagnosedCase(caseId)).action).toBe("skipped");
    } finally {
      await root.cleanup();
    }
  });
});

// ── Phase B: mutual exclusion (FR-015c / C6) ────────────────────────────────

test.describe("mutual exclusion on the slow path", () => {
  test("a second escalation queues behind the first, then starts when the slot frees", async () => {
    const root = useSelfHealTestRoot("route-mutex");
    try {
      root.writeConfig(ALL_TRIGGERS_ON);
      const runs = stubHooks({ diagnosis: { scopeClass: "e", ownership: "bos-core", proposedSurface: "src/a.ts" } });

      const first = await intake.selfHealIntake(HARD, { awaitDiagnosis: true });
      const second = await intake.selfHealIntake(
        { trigger: "hard-error", toolName: "file_write", errorMessage: "params is not a function" },
        { awaitDiagnosis: true },
      );
      if (first.action !== "created" || second.action !== "created") throw new Error("expected two cases");

      expect((await getCase(first.caseId))?.status).toBe("bs-pipeline");
      expect((await getCase(second.caseId))?.status).toBe("queued-slow");
      expect(await readIndex().then((i) => i.slowQueue.map((e) => e.caseId))).toEqual([second.caseId]);
      expect(runs).toEqual([first.caseId]);

      // The first one finishes → the queued one is dequeued and escalated.
      // Dequeuing is RE-ENTRY, so it is deliberately not re-deduped or re-capped.
      const started = await intake.releaseSlotAndDequeue(first.caseId);
      expect(started).toBe(second.caseId);
      expect((await getCase(second.caseId))?.status).toBe("bs-pipeline");
      expect((await readIndex()).inFlightSlowPathCaseId).toBe(second.caseId);
      expect(runs).toEqual([first.caseId, second.caseId]);
    } finally {
      await root.cleanup();
    }
  });

  test("releasing the slot skips cases the user closed while they waited", async () => {
    const root = useSelfHealTestRoot("route-mutex-skip");
    try {
      root.writeConfig(ALL_TRIGGERS_ON);
      stubHooks({ diagnosis: { scopeClass: "e", ownership: "bos-core", proposedSurface: "src/a.ts" } });
      const first = await intake.selfHealIntake(HARD, { awaitDiagnosis: true });
      const second = await intake.selfHealIntake(
        { trigger: "hard-error", toolName: "file_write", errorMessage: "params is not a function" },
        { awaitDiagnosis: true },
      );
      if (first.action !== "created" || second.action !== "created") throw new Error("expected two cases");
      await updateCase(second.caseId, { status: "dismissed" });

      expect(await intake.releaseSlotAndDequeue(first.caseId)).toBeUndefined();
      expect((await readIndex()).inFlightSlowPathCaseId).toBeNull();
    } finally {
      await root.cleanup();
    }
  });

  test("re-escalating a case already in the pipeline is a no-op", async () => {
    const root = useSelfHealTestRoot("route-mutex-reescalate");
    try {
      root.writeConfig(ALL_TRIGGERS_ON);
      stubHooks({ diagnosis: { scopeClass: "e", ownership: "bos-core", proposedSurface: "src/a.ts" } });
      const first = await intake.selfHealIntake(HARD, { awaitDiagnosis: true });
      if (first.action !== "created") throw new Error("expected a case");
      expect((await intake.escalateCase(first.caseId)).action).toBe("skipped");
    } finally {
      await root.cleanup();
    }
  });
});

// ── Suspend / resume (FR-016) ───────────────────────────────────────────────

test.describe("suspend and resume", () => {
  test("suspending records the question and HOLDS the slot", async () => {
    const root = useSelfHealTestRoot("suspend");
    try {
      root.writeConfig(ALL_TRIGGERS_ON);
      stubHooks({ diagnosis: { scopeClass: "e", ownership: "bos-core", proposedSurface: "src/a.ts" } });
      const created = await intake.selfHealIntake(HARD, { awaitDiagnosis: true });
      if (created.action !== "created") throw new Error("expected a case");

      const suspended = await intake.suspendCase(created.caseId, "tool A or tool B?");
      expect(suspended?.status).toBe("suspended");
      expect(suspended?.pendingQuestion).toBe("tool A or tool B?");
      expect(suspended?.suspendedAt).toBeGreaterThan(0);
      // An unanswered question still blocks the pipeline (ADR-9).
      expect((await readIndex()).inFlightSlowPathCaseId).toBe(created.caseId);
    } finally {
      await root.cleanup();
    }
  });

  test("answering resumes the SAME conversation and records the answer", async () => {
    const root = useSelfHealTestRoot("resume");
    try {
      root.writeConfig(ALL_TRIGGERS_ON);
      const runs = stubHooks({ diagnosis: { scopeClass: "e", ownership: "bos-core", proposedSurface: "src/a.ts" } });
      const created = await intake.selfHealIntake(HARD, { awaitDiagnosis: true });
      if (created.action !== "created") throw new Error("expected a case");
      await intake.suspendCase(created.caseId, "tool A or tool B?");

      const resumed = await intake.resumeCase(created.caseId, "tool A");
      expect(resumed?.status).toBe("bs-pipeline");
      expect(resumed?.decisionAnswer).toBe("tool A");
      expect(resumed?.pendingQuestion).toBeUndefined();
      // Same conversation — the agent recovers its decisions from the artifacts.
      expect(resumed?.conversationId).toBe(`c-self-heal-fix-${created.caseId}`);
      expect(runs).toEqual([created.caseId, created.caseId]);
    } finally {
      await root.cleanup();
    }
  });

  test("resuming a case that is not suspended changes nothing", async () => {
    const root = useSelfHealTestRoot("resume-not-suspended");
    try {
      root.writeConfig(ALL_TRIGGERS_ON);
      stubHooks({ diagnosis: { scopeClass: "a", ownership: "env", proposedSurface: "disk" } });
      const created = await intake.selfHealIntake(HARD, { awaitDiagnosis: true });
      if (created.action !== "created") throw new Error("expected a case");
      const record = await intake.resumeCase(created.caseId, "an answer nobody asked for");
      expect(record?.status).toBe("env-only");
      expect(record?.decisionAnswer).toBeUndefined();
    } finally {
      await root.cleanup();
    }
  });

  test("resuming an unknown case returns undefined", async () => {
    const root = useSelfHealTestRoot("resume-unknown");
    try {
      expect(await intake.resumeCase("nope", "x")).toBeUndefined();
      expect(await intake.suspendCase("nope", "x")).toBeUndefined();
    } finally {
      await root.cleanup();
    }
  });
});
