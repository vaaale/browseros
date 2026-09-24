import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import { join } from "path";
import * as intake from "../../src/lib/self-heal/intake";
import { buildAutonomousBrief, buildResumeBrief } from "../../src/lib/self-heal/brief";
import { triggerContextFromEvent } from "../../src/lib/self-heal/spine-handler";
import { storeDiagnosticsReport } from "../../src/lib/self-heal/diagnostician";
import { createCase, getCase, readIndex, updateCase, withIndex } from "../../src/lib/self-heal/store";
import { computeFailureSignature } from "../../src/lib/self-heal/signature";
import { isValidFeatureBranch } from "../../src/lib/agent/feature-branch";
import { SELF_HEAL_DEFAULTS, selfHealBranchFor, humanCaseId } from "../../src/lib/self-heal/types";
import { useSelfHealTestRoot } from "./_test-env";
import type { EventRecord } from "../../src/lib/events/types";
import type { TriggerContext } from "../../src/lib/self-heal/types";

// 031-self-healing — the slow-path handoff (FR-015/015a/015b, ADR-3/ADR-8).
//
// This is the riskiest seam in the feature, and it has one hard ordering
// requirement: the BS conversation's `activeFeatureBranch` must be set BEFORE
// the agent's first token, or the agent calls `dev_branch_request` — a frontend
// elicitation that nothing will ever answer in an autonomous run, so the run
// would hang until it timed out.

const HARD: TriggerContext = { trigger: "hard-error", toolName: "bos_app_launch", errorMessage: "params is not accepted" };
const ALL_ON = { enabled: true, "triggers.hardError": true, "triggers.explicit": true };

async function diagnosedClassE(root: { dir: string }) {
  const record = await createCase({
    trigger: "hard-error",
    title: "bos_app_launch drops params",
    signature: computeFailureSignature(HARD),
    context: HARD,
  });
  await storeDiagnosticsReport(
    record.id,
    {
      caseId: record.id,
      scopeClass: "e",
      ownership: "bos-core",
      proposedSurface: "src/lib/assistant/tools/frontend-declarations.ts + FrontendToolsV2.tsx",
      verdict: "genuine gap: the tool schema never declares params",
    },
    "## Investigation\n\n`src/store/os-store.ts:11` has always accepted params; `frontend-declarations.ts:16` does not declare it.",
  );
  void root;
  return record.id;
}

test.afterEach(() => {
  intake._setSpineAgentHooksForTests(null);
});

/**
 * A minimal stand-in for the Supervisor's `/__supervisor/state` endpoint.
 *
 * `completeFix` deliberately verifies the preview's REAL build state rather
 * than taking the agent's word for it (ADR-8), so testing that gate honestly
 * needs something to answer the request. `bodyFn` is read per request so a test
 * can decide the answer after the case (and therefore the branch name) exists.
 */
async function stubSupervisor(
  initial: Record<string, unknown>,
  bodyFn?: () => Record<string, unknown>,
): Promise<{ server: import("node:http").Server; url: string }> {
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(bodyFn ? bodyFn() : initial));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}` };
}

test.describe("FR-015b — the branch is pre-conditioned before the first token", () => {
  test("the conversation is seeded AND branch-set before runPipeline is ever called", async () => {
    const root = useSelfHealTestRoot("handoff-branch-order");
    try {
      root.writeConfig(ALL_ON);
      // Captured AT the moment the pipeline launch happens — that is the
      // ordering assertion; checking afterwards would prove nothing.
      const seenAtLaunch: { branch?: string; firstMessage?: string }[] = [];
      intake._setSpineAgentHooksForTests({
        agentAvailable: async () => true,
        runPipeline: async ({ conversationId }) => {
          const file = join(root.dir, "vfs", "Documents", "Chats", `${conversationId}.json`);
          const parsed = JSON.parse(readFileSync(file, "utf8")) as {
            activeFeatureBranch?: string;
            messages?: { content?: string }[];
            selfHeal?: unknown;
          };
          seenAtLaunch.push({ branch: parsed.activeFeatureBranch, firstMessage: parsed.messages?.[0]?.content });
          return new Promise(() => {});
        },
      });

      const caseId = await diagnosedClassE(root);
      await intake.resolveDiagnosedCase(caseId);

      expect(seenAtLaunch).toHaveLength(1);
      expect(seenAtLaunch[0].branch).toBe(`bos/self-heal-${caseId}`);
      // The brief is already the conversation's first message, so the agent's
      // very first turn reads it.
      expect(seenAtLaunch[0].firstMessage).toContain("pre-authorized");
    } finally {
      await root.cleanup();
    }
  });

  test("the seeded conversation carries the re-entrancy marker", async () => {
    const root = useSelfHealTestRoot("handoff-marker");
    try {
      root.writeConfig(ALL_ON);
      intake._setSpineAgentHooksForTests({ agentAvailable: async () => true, runPipeline: async () => new Promise(() => {}) });
      const caseId = await diagnosedClassE(root);
      await intake.resolveDiagnosedCase(caseId);

      const file = join(root.dir, "vfs", "Documents", "Chats", `c-self-heal-fix-${caseId}.json`);
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { selfHeal?: { role?: string; caseId?: string } };
      expect(parsed.selfHeal).toEqual({ role: "pipeline", caseId });
    } finally {
      await root.cleanup();
    }
  });

  test("the derived branch name is a VALID feature branch for any case id", () => {
    // ADR-3: `caseId` is one lowercase [a-z0-9]+ segment precisely so
    // `bos/self-heal-<id>` satisfies FEATURE_BRANCH_RE's four-segment limit.
    for (const id of ["0001", "0042", "1234", "9999", "a1"]) {
      expect(isValidFeatureBranch(selfHealBranchFor(id))).toBe(true);
    }
    expect(selfHealBranchFor("0141")).toBe("bos/self-heal-0141");
    // The EHS- prefix is presentation only and never part of the branch.
    expect(humanCaseId("0141")).toBe("EHS-0141");
    expect(selfHealBranchFor("0141")).not.toContain("EHS");
  });

  test("class d-bis gets NO feature branch — it ships via app_build", async () => {
    const root = useSelfHealTestRoot("handoff-dbis");
    try {
      root.writeConfig(ALL_ON);
      const launches: { featureBranch?: string }[] = [];
      intake._setSpineAgentHooksForTests({
        agentAvailable: async () => true,
        runPipeline: async (input) => {
          launches.push({ featureBranch: input.featureBranch });
          return new Promise(() => {});
        },
      });
      const caseId = await diagnosedClassE(root);
      await updateCase(caseId, { scopeClass: "d-bis", ownership: "user-app", appId: "okf-knowledge-base" });
      await intake.escalateCase(caseId);

      expect(launches).toHaveLength(1);
      expect(launches[0].featureBranch).toBeUndefined();
      expect((await getCase(caseId))?.activeFeatureBranch).toBeUndefined();
    } finally {
      await root.cleanup();
    }
  });

  test("a missing Build Studio agent fails the case and frees the slot", async () => {
    const root = useSelfHealTestRoot("handoff-no-agent");
    try {
      root.writeConfig(ALL_ON);
      intake._setSpineAgentHooksForTests({ agentAvailable: async () => false });
      const caseId = await diagnosedClassE(root);
      const outcome = await intake.resolveDiagnosedCase(caseId);
      expect(outcome.action).toBe("skipped");
      expect((await getCase(caseId))?.status).toBe("failed");
      expect((await readIndex()).inFlightSlowPathCaseId).toBeNull();
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("the autonomous brief carries the constraints code cannot enforce", () => {
  test("FR-015 pre-authorization + commit-before-advance", async () => {
    const root = useSelfHealTestRoot("brief-fr015");
    try {
      const caseId = await diagnosedClassE(root);
      const record = await getCase(caseId);
      if (!record) throw new Error("missing case");
      const brief = buildAutonomousBrief({
        record,
        cfg: SELF_HEAL_DEFAULTS,
        reportBody: "## Investigation\n\nsee src/x.ts:1",
        featureBranch: selfHealBranchFor(caseId),
      });

      expect(brief).toContain("The user has pre-authorized this fix. Run the full pipeline autonomously.");
      expect(brief).toContain("Stop only if you encounter a decision you cannot resolve autonomously.");
      expect(brief).toContain("self_heal_request_decision");
      expect(brief).toContain("Commit-before-advance");
      expect(brief).toContain("before you ask the next question");
    } finally {
      await root.cleanup();
    }
  });

  test("FR-015a classification verification: ONE re-diagnosis, then the user", async () => {
    const root = useSelfHealTestRoot("brief-fr015a");
    try {
      const caseId = await diagnosedClassE(root);
      const record = await getCase(caseId);
      if (!record) throw new Error("missing case");
      const brief = buildAutonomousBrief({ record, cfg: SELF_HEAL_DEFAULTS, reportBody: "body" });

      expect(brief).toContain("plan → tasks");
      expect(brief).toContain("exactly ONE");
      expect(brief).toContain("agent_delegate(conversation-reviewer");
      expect(brief).toContain("Do not attempt a second re-diagnosis");
      // The proposedSurface has to be IN the brief — it is what the check
      // compares the plan's file list against.
      expect(brief).toContain("frontend-declarations.ts");
    } finally {
      await root.cleanup();
    }
  });

  test("FR-014 TDD, the coverage target, and the file list as a HARD scope constraint", async () => {
    const root = useSelfHealTestRoot("brief-fr014");
    try {
      const caseId = await diagnosedClassE(root);
      const record = await getCase(caseId);
      if (!record) throw new Error("missing case");
      const brief = buildAutonomousBrief({ record, cfg: SELF_HEAL_DEFAULTS, reportBody: "body" });

      expect(brief).toContain("Write the failing test FIRST");
      expect(brief).toContain("≥95% line and branch coverage");
      expect(brief).toContain("You may modify ONLY these files");
      expect(brief).toContain("SUBSET of the plan's list");
      expect(brief).toContain("tools/supervisor/**");
    } finally {
      await root.cleanup();
    }
  });

  test("the coverage target follows the configured value", async () => {
    const root = useSelfHealTestRoot("brief-coverage");
    try {
      const caseId = await diagnosedClassE(root);
      const record = await getCase(caseId);
      if (!record) throw new Error("missing case");
      const brief = buildAutonomousBrief({
        record,
        cfg: { ...SELF_HEAL_DEFAULTS, tdd: { required: true, targetCoverage: 80 } },
        reportBody: "body",
      });
      expect(brief).toContain("≥80% line and branch coverage");
    } finally {
      await root.cleanup();
    }
  });

  test("with TDD off, a regression test is still required", async () => {
    const root = useSelfHealTestRoot("brief-no-tdd");
    try {
      const caseId = await diagnosedClassE(root);
      const record = await getCase(caseId);
      if (!record) throw new Error("missing case");
      const brief = buildAutonomousBrief({
        record,
        cfg: { ...SELF_HEAL_DEFAULTS, tdd: { required: false, targetCoverage: 95 } },
        reportBody: "body",
      });
      expect(brief).not.toContain("Write the failing test FIRST");
      expect(brief).toContain("regression test that fails without the fix");
    } finally {
      await root.cleanup();
    }
  });

  test("C3: the report is passed as USER INTENT, and specify must produce the spec", async () => {
    const root = useSelfHealTestRoot("brief-c3");
    try {
      const caseId = await diagnosedClassE(root);
      const record = await getCase(caseId);
      if (!record) throw new Error("missing case");
      const brief = buildAutonomousBrief({ record, cfg: SELF_HEAL_DEFAULTS, reportBody: "## Investigation\n\nsee src/x.ts:1" });
      expect(brief).toContain("user intent");
      expect(brief).toContain("<diagnostics-report>");
      expect(brief).toContain("see src/x.ts:1");
      expect(brief).toContain("not copy it in");
    } finally {
      await root.cleanup();
    }
  });

  test("class e is told never to call dev_branch_request; class d-bis is told to use app_build", async () => {
    const root = useSelfHealTestRoot("brief-delivery");
    try {
      const caseId = await diagnosedClassE(root);
      const core = await getCase(caseId);
      if (!core) throw new Error("missing case");
      const coreBrief = buildAutonomousBrief({ record: core, cfg: SELF_HEAL_DEFAULTS, reportBody: "b" });
      expect(coreBrief).toContain("never");
      expect(coreBrief).toContain("dev_branch_request");
      expect(coreBrief).toContain("self_heal_complete_fix");
      expect(coreBrief).toContain("You do NOT promote");

      await updateCase(caseId, { scopeClass: "d-bis", appId: "okf-knowledge-base" });
      const app = await getCase(caseId);
      if (!app) throw new Error("missing case");
      const appBrief = buildAutonomousBrief({ record: app, cfg: SELF_HEAL_DEFAULTS, reportBody: "b" });
      expect(appBrief).toContain("app_build");
      expect(appBrief).toContain("okf-knowledge-base");
      expect(appBrief).not.toContain("dev_branch_request");
    } finally {
      await root.cleanup();
    }
  });

  test("the resume brief restates the question, the answer, and commit-before-advance", async () => {
    const root = useSelfHealTestRoot("brief-resume");
    try {
      const caseId = await diagnosedClassE(root);
      await updateCase(caseId, { status: "suspended", pendingQuestion: "tool A or tool B?" });
      const record = await getCase(caseId);
      if (!record) throw new Error("missing case");
      const brief = buildResumeBrief(record, "tool A, because it owns the schema");
      expect(brief).toContain("tool A or tool B?");
      expect(brief).toContain("tool A, because it owns the schema");
      expect(brief).toContain("commit-before-advance");
      expect(brief).toContain("artifacts on disk");
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("completeFix (FR-017 / ADR-8)", () => {
  test("a healthy case becomes preview-ready, records the fix, and frees the slot", async () => {
    const root = useSelfHealTestRoot("complete-ok");
    try {
      root.writeConfig(ALL_ON);
      const caseId = await diagnosedClassE(root);
      await updateCase(caseId, { status: "bs-pipeline", activeFeatureBranch: selfHealBranchFor(caseId) });
      await withIndex((index) => {
        index.inFlightSlowPathCaseId = caseId;
      });

      const outcome = await intake.completeFix({
        caseId,
        branch: selfHealBranchFor(caseId),
        summary: "Declared params on bos_app_launch and passed it through to store.launch.",
      });
      expect(outcome.ok).toBe(true);
      const record = await getCase(caseId);
      expect(record?.status).toBe("preview-ready");
      expect(record?.fixSummary).toContain("bos_app_launch");
      expect(record?.fixLink).toContain(caseId);
      expect((await readIndex()).inFlightSlowPathCaseId).toBeNull();
    } finally {
      await root.cleanup();
    }
  });

  test("calling it twice does not emit a second fix_ready", async () => {
    const root = useSelfHealTestRoot("complete-idempotent");
    try {
      root.writeConfig(ALL_ON);
      const caseId = await diagnosedClassE(root);
      await updateCase(caseId, { status: "bs-pipeline", activeFeatureBranch: selfHealBranchFor(caseId) });
      const first = await intake.completeFix({ caseId, branch: selfHealBranchFor(caseId), summary: "s" });
      expect(first.ok && first.eventId).toBeTruthy();
      const second = await intake.completeFix({ caseId, branch: selfHealBranchFor(caseId), summary: "s" });
      expect(second.ok).toBe(true);
      if (second.ok) expect(second.eventId).toBeUndefined();
    } finally {
      await root.cleanup();
    }
  });

  test("a case with neither a branch nor an appId is refused", async () => {
    const root = useSelfHealTestRoot("complete-no-target");
    try {
      root.writeConfig(ALL_ON);
      const caseId = await diagnosedClassE(root);
      await updateCase(caseId, { status: "bs-pipeline" });
      const outcome = await intake.completeFix({ caseId, summary: "s" });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toContain("branch");
    } finally {
      await root.cleanup();
    }
  });

  test("a terminal case cannot be completed", async () => {
    const root = useSelfHealTestRoot("complete-terminal");
    try {
      root.writeConfig(ALL_ON);
      const caseId = await diagnosedClassE(root);
      await updateCase(caseId, { status: "dismissed" });
      const outcome = await intake.completeFix({ caseId, branch: "bos/testfixture-x", summary: "s" });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toContain("dismissed");
    } finally {
      await root.cleanup();
    }
  });

  test("an unknown case is refused", async () => {
    const root = useSelfHealTestRoot("complete-unknown");
    try {
      const outcome = await intake.completeFix({ caseId: "nope", summary: "s" });
      expect(outcome.ok).toBe(false);
    } finally {
      await root.cleanup();
    }
  });

  test("completing frees the slot AND starts the next queued fix", async () => {
    const root = useSelfHealTestRoot("complete-dequeues");
    try {
      root.writeConfig(ALL_ON);
      const launched: string[] = [];
      intake._setSpineAgentHooksForTests({
        agentAvailable: async () => true,
        runPipeline: async (input) => {
          launched.push(input.caseId);
          return new Promise(() => {});
        },
      });
      const first = await diagnosedClassE(root);
      await intake.resolveDiagnosedCase(first);
      const second = await diagnosedClassE(root);
      await intake.resolveDiagnosedCase(second);
      expect((await getCase(second))?.status).toBe("queued-slow");

      await intake.completeFix({ caseId: first, branch: selfHealBranchFor(first), summary: "done" });
      expect((await getCase(second))?.status).toBe("bs-pipeline");
      expect(launched).toEqual([first, second]);
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("boot reconcile (design R9)", () => {
  test("a bs-pipeline case with no live run and no preview is failed, not left holding the slot", async () => {
    const root = useSelfHealTestRoot("reconcile-orphan");
    try {
      root.writeConfig(ALL_ON);
      const caseId = await diagnosedClassE(root);
      await updateCase(caseId, { status: "bs-pipeline", activeFeatureBranch: selfHealBranchFor(caseId) });
      await withIndex((index) => {
        index.inFlightSlowPathCaseId = caseId;
      });

      const summary = await intake.reconcileInFlightCases();
      expect(summary.failed).toContain(caseId);
      expect((await getCase(caseId))?.status).toBe("failed");
      expect((await readIndex()).inFlightSlowPathCaseId).toBeNull();
    } finally {
      await root.cleanup();
    }
  });

  test("a d-bis case with no branch to interrogate is failed honestly", async () => {
    const root = useSelfHealTestRoot("reconcile-dbis");
    try {
      root.writeConfig(ALL_ON);
      const caseId = await diagnosedClassE(root);
      await updateCase(caseId, { status: "bs-pipeline", scopeClass: "d-bis", appId: "okf-knowledge-base" });
      const summary = await intake.reconcileInFlightCases();
      expect(summary.failed).toContain(caseId);
      expect((await getCase(caseId))?.error).toContain("did not survive a restart");
    } finally {
      await root.cleanup();
    }
  });

  test("reconcile also sweeps suspended timeouts and starts the queue", async () => {
    const root = useSelfHealTestRoot("reconcile-sweep");
    try {
      root.writeConfig({ ...ALL_ON, suspendedTimeoutDays: 1 });
      const stale = await diagnosedClassE(root);
      await updateCase(stale, { status: "suspended", suspendedAt: Date.now() - 3 * 86_400_000 });

      const launched: string[] = [];
      intake._setSpineAgentHooksForTests({
        agentAvailable: async () => true,
        runPipeline: async (input) => {
          launched.push(input.caseId);
          return new Promise(() => {});
        },
      });
      const queued = await diagnosedClassE(root);
      await updateCase(queued, { status: "queued-slow" });
      await withIndex((index) => {
        index.slowQueue.push({ caseId: queued, at: Date.now() });
      });

      const summary = await intake.reconcileInFlightCases();
      expect(summary.abandoned).toContain(stale);
      expect(summary.requeued).toContain(queued);
      expect(launched).toEqual([queued]);
    } finally {
      await root.cleanup();
    }
  });

  test("a clean install reconciles to nothing", async () => {
    const root = useSelfHealTestRoot("reconcile-clean");
    try {
      const summary = await intake.reconcileInFlightCases();
      expect(summary).toEqual({ fixReadyEmitted: [], failed: [], abandoned: [], requeued: [], settled: [] });
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("triggerContextFromEvent (FR-004 / FR-005 tolerance)", () => {
  function evt(payload: Record<string, unknown>): EventRecord {
    return { id: "e-1", type: "com.bos.self-heal.trigger", payload, source: { appId: "x", name: "X" }, ts: Date.now(), sequence: 1, summary: "s" };
  }

  test("reads only the three fields FR-004 names from a workflow-timeout event", () => {
    // 002 does not emit this event yet (design R7 — a cross-spec dependency),
    // so the mapping must work off a minimal, unknown-shaped body.
    const ctx = triggerContextFromEvent(evt({ trigger: "workflow-timeout", workflowId: "daily-review", node: "research", configuredMs: 10_000, actualMs: 42_000 }));
    expect(ctx?.trigger).toBe("workflow-timeout");
    expect(ctx?.workflow).toEqual({ id: "daily-review", node: "research", configuredMs: 10_000, actualMs: 42_000 });
    expect(ctx?.toolName).toBe("workflow:daily-review");
  });

  test("also accepts a nested workflow object", () => {
    const ctx = triggerContextFromEvent(evt({ workflow: { id: "wf", node: "n" } }));
    expect(ctx?.workflow?.id).toBe("wf");
  });

  test("a workflow event with no id is ignored rather than guessed at", () => {
    expect(triggerContextFromEvent(evt({ trigger: "workflow-timeout" }))).toBeUndefined();
  });

  test("maps a log-error event and keeps its component", () => {
    const ctx = triggerContextFromEvent(evt({ trigger: "log-events", component: "assistant.run-manager", message: "run wedged", level: "error" }));
    expect(ctx?.trigger).toBe("log-events");
    expect(ctx?.component).toBe("assistant.run-manager");
    expect(ctx?.errorMessage).toBe("run wedged");
  });

  test("a log event with no component is ignored", () => {
    expect(triggerContextFromEvent(evt({ trigger: "log-events", message: "x" }))).toBeUndefined();
  });

  test("maps an explicit / hard-error trigger with its full context", () => {
    const ctx = triggerContextFromEvent(
      evt({ trigger: "hard-error", toolName: "file_read", errorMessage: "permission denied", errorCode: "EACCES", httpStatus: 0, conversationId: "c-1", filePath: "/x", appId: "a" }),
    );
    expect(ctx?.trigger).toBe("hard-error");
    expect(ctx?.toolName).toBe("file_read");
    expect(ctx?.errorCode).toBe("EACCES");
    expect(ctx?.conversationId).toBe("c-1");
    expect(ctx?.filePath).toBe("/x");
    expect(ctx?.appId).toBe("a");
    expect(ctx?.eventId).toBe("e-1");
  });

  test("an unrecognized trigger name falls back to explicit rather than being dropped", () => {
    const ctx = triggerContextFromEvent(evt({ trigger: "something-new", description: "x" }));
    expect(ctx?.trigger).toBe("explicit");
  });
});

test.describe("previewStateFor + the Supervisor gate (ADR-8)", () => {
  test("returns undefined when BOS is not under the Supervisor — the agent's report stands", async () => {
    const root = useSelfHealTestRoot("preview-no-supervisor");
    const previous = process.env.BOS_SUPERVISOR_URL;
    delete process.env.BOS_SUPERVISOR_URL;
    try {
      expect(await intake.previewStateFor("bos/self-heal-0001")).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.BOS_SUPERVISOR_URL;
      else process.env.BOS_SUPERVISOR_URL = previous;
      await root.cleanup();
    }
  });

  test("returns undefined when the Supervisor is unreachable, rather than failing the fix", async () => {
    const root = useSelfHealTestRoot("preview-unreachable");
    const previous = process.env.BOS_SUPERVISOR_URL;
    // A port nothing is listening on.
    process.env.BOS_SUPERVISOR_URL = "http://127.0.0.1:1";
    try {
      expect(await intake.previewStateFor("bos/self-heal-0001")).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.BOS_SUPERVISOR_URL;
      else process.env.BOS_SUPERVISOR_URL = previous;
      await root.cleanup();
    }
  });

  test("reads the real preview state, and a NOT-ready preview fails the fix instead of notifying", async () => {
    const root = useSelfHealTestRoot("preview-not-ready");
    const previous = process.env.BOS_SUPERVISOR_URL;
    const { server, url } = await stubSupervisor({ previews: [{ role: "preview", branch: "bos/self-heal-0001", state: "failed" }] });
    process.env.BOS_SUPERVISOR_URL = url;
    try {
      root.writeConfig(ALL_ON);
      expect(await intake.previewStateFor("bos/self-heal-0001")).toBe("failed");

      const caseId = await diagnosedClassE(root);
      await updateCase(caseId, { status: "bs-pipeline", activeFeatureBranch: "bos/self-heal-0001" });
      const outcome = await intake.completeFix({ caseId, branch: "bos/self-heal-0001", summary: "s" });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toContain('is "failed", not ready');
      // The agent said tests passed; BOS checked the build and disagreed.
      expect((await getCase(caseId))?.status).toBe("failed");
    } finally {
      server.close();
      if (previous === undefined) delete process.env.BOS_SUPERVISOR_URL;
      else process.env.BOS_SUPERVISOR_URL = previous;
      await root.cleanup();
    }
  });

  test("a READY preview lets the fix complete", async () => {
    const root = useSelfHealTestRoot("preview-ready");
    const previous = process.env.BOS_SUPERVISOR_URL;
    const { server, url } = await stubSupervisor({ previews: [{ role: "preview", branch: "bos/self-heal-0001", state: "ready" }] });
    process.env.BOS_SUPERVISOR_URL = url;
    try {
      root.writeConfig(ALL_ON);
      const caseId = await diagnosedClassE(root);
      await updateCase(caseId, { status: "bs-pipeline", activeFeatureBranch: "bos/self-heal-0001" });
      const outcome = await intake.completeFix({ caseId, branch: "bos/self-heal-0001", summary: "s" });
      expect(outcome.ok).toBe(true);
      expect((await getCase(caseId))?.status).toBe("preview-ready");
    } finally {
      server.close();
      if (previous === undefined) delete process.env.BOS_SUPERVISOR_URL;
      else process.env.BOS_SUPERVISOR_URL = previous;
      await root.cleanup();
    }
  });

  test("reconcile recovers the crash-between-build-and-tool window (ADR-8's fallback)", async () => {
    const root = useSelfHealTestRoot("preview-reconcile-ready");
    const previous = process.env.BOS_SUPERVISOR_URL;
    let branch = "";
    const { server, url } = await stubSupervisor({ previews: [] }, () => ({
      previews: [{ role: "preview", branch, state: "ready" }],
    }));
    process.env.BOS_SUPERVISOR_URL = url;
    try {
      root.writeConfig(ALL_ON);
      const caseId = await diagnosedClassE(root);
      branch = selfHealBranchFor(caseId);
      // The run was killed AFTER a healthy build but BEFORE it called
      // self_heal_complete_fix — the exact window ADR-8 keeps option B for.
      await updateCase(caseId, { status: "bs-pipeline", activeFeatureBranch: branch });
      await withIndex((index) => {
        index.inFlightSlowPathCaseId = caseId;
      });

      const summary = await intake.reconcileInFlightCases();
      expect(summary.fixReadyEmitted).toContain(caseId);
      const record = await getCase(caseId);
      expect(record?.status).toBe("preview-ready");
      expect(record?.fixSummary).toContain("recovered after a restart");
      expect((await readIndex()).inFlightSlowPathCaseId).toBeNull();
    } finally {
      server.close();
      if (previous === undefined) delete process.env.BOS_SUPERVISOR_URL;
      else process.env.BOS_SUPERVISOR_URL = previous;
      await root.cleanup();
    }
  });

  test("reconcile leaves a still-BUILDING preview alone", async () => {
    const root = useSelfHealTestRoot("preview-reconcile-building");
    const previous = process.env.BOS_SUPERVISOR_URL;
    let branch = "";
    const { server, url } = await stubSupervisor({ previews: [] }, () => ({
      previews: [{ role: "preview", branch, state: "building" }],
    }));
    process.env.BOS_SUPERVISOR_URL = url;
    try {
      root.writeConfig(ALL_ON);
      const caseId = await diagnosedClassE(root);
      branch = selfHealBranchFor(caseId);
      await updateCase(caseId, { status: "bs-pipeline", activeFeatureBranch: branch });
      const summary = await intake.reconcileInFlightCases();
      expect(summary.failed).not.toContain(caseId);
      expect(summary.fixReadyEmitted).not.toContain(caseId);
      expect((await getCase(caseId))?.status).toBe("bs-pipeline");
    } finally {
      server.close();
      if (previous === undefined) delete process.env.BOS_SUPERVISOR_URL;
      else process.env.BOS_SUPERVISOR_URL = previous;
      await root.cleanup();
    }
  });

  test("reconcile marks a FAILED preview failed", async () => {
    const root = useSelfHealTestRoot("preview-reconcile-failed");
    const previous = process.env.BOS_SUPERVISOR_URL;
    let branch = "";
    const { server, url } = await stubSupervisor({ previews: [] }, () => ({
      previews: [{ role: "preview", branch, state: "failed" }],
    }));
    process.env.BOS_SUPERVISOR_URL = url;
    try {
      root.writeConfig(ALL_ON);
      const caseId = await diagnosedClassE(root);
      branch = selfHealBranchFor(caseId);
      await updateCase(caseId, { status: "bs-pipeline", activeFeatureBranch: branch });
      const summary = await intake.reconcileInFlightCases();
      expect(summary.failed).toContain(caseId);
      expect((await getCase(caseId))?.error).toContain("failed to build");
    } finally {
      server.close();
      if (previous === undefined) delete process.env.BOS_SUPERVISOR_URL;
      else process.env.BOS_SUPERVISOR_URL = previous;
      await root.cleanup();
    }
  });
});

test.describe("the pipeline run ending without a fix", () => {
  test("a run that errors marks the case failed (no auto-retry) and frees the slot", async () => {
    const root = useSelfHealTestRoot("pipeline-error");
    try {
      root.writeConfig(ALL_ON);
      intake._setSpineAgentHooksForTests({
        agentAvailable: async () => true,
        runPipeline: async () => ({ output: "", error: "the developer harness is not installed" }),
      });
      const caseId = await diagnosedClassE(root);
      await intake.resolveDiagnosedCase(caseId);

      await expect.poll(async () => (await getCase(caseId))?.status).toBe("failed");
      expect((await getCase(caseId))?.error).toContain("developer harness");
      expect((await readIndex()).inFlightSlowPathCaseId).toBeNull();
    } finally {
      await root.cleanup();
    }
  });

  test("a run that returns cleanly WITHOUT calling complete_fix is still a failure", async () => {
    const root = useSelfHealTestRoot("pipeline-silent");
    try {
      root.writeConfig(ALL_ON);
      intake._setSpineAgentHooksForTests({
        agentAvailable: async () => true,
        runPipeline: async () => ({ output: "I had a nice think about it." }),
      });
      const caseId = await diagnosedClassE(root);
      await intake.resolveDiagnosedCase(caseId);
      await expect.poll(async () => (await getCase(caseId))?.status).toBe("failed");
      expect((await getCase(caseId))?.error).toContain("without reporting a completed fix");
    } finally {
      await root.cleanup();
    }
  });

  test("a run that THREW is reported with its reason", async () => {
    const root = useSelfHealTestRoot("pipeline-throw");
    try {
      root.writeConfig(ALL_ON);
      intake._setSpineAgentHooksForTests({
        agentAvailable: async () => true,
        runPipeline: async () => {
          throw new Error("worker died");
        },
      });
      const caseId = await diagnosedClassE(root);
      await intake.resolveDiagnosedCase(caseId);
      await expect.poll(async () => (await getCase(caseId))?.status).toBe("failed");
      expect((await getCase(caseId))?.error).toContain("worker died");
    } finally {
      await root.cleanup();
    }
  });

  test("a run that ended AFTER the case suspended does not overwrite the suspension", async () => {
    const root = useSelfHealTestRoot("pipeline-suspended");
    try {
      root.writeConfig(ALL_ON);
      let settle: (() => void) | undefined;
      intake._setSpineAgentHooksForTests({
        agentAvailable: async () => true,
        runPipeline: async () =>
          new Promise((resolve) => {
            settle = () => resolve({ output: "" });
          }),
      });
      const caseId = await diagnosedClassE(root);
      await intake.resolveDiagnosedCase(caseId);
      // The agent suspended via the tool, THEN its run ended — the ordinary
      // terminate-and-retrigger shape (C5). The suspension must survive.
      await intake.suspendCase(caseId, "A or B?");
      settle?.();
      await new Promise((r) => setTimeout(r, 50));
      expect((await getCase(caseId))?.status).toBe("suspended");
    } finally {
      await root.cleanup();
    }
  });

  test("the real (unstubbed) agentAvailable hook resolves the configured Build Studio agent", async () => {
    const root = useSelfHealTestRoot("pipeline-real-hooks");
    try {
      root.writeConfig(ALL_ON);
      // agentAvailable is left REAL — that resolution is what this test is
      // for, and it runs before anything is seeded. Only runPipeline is
      // stubbed, to the same "run failed" result an unusable provider
      // produces, so the real end-of-run handling still has to mark the case
      // failed rather than leave it holding the slot.
      //
      // It used to leave runPipeline real too, on the premise that "without a
      // provider the run fails". That premise was false: src/lib/agent/llm.ts
      // sends the request even with no api key, so this made a live model call
      // and polled for up to 20s waiting on an external service to reject it.
      intake._setSpineAgentHooksForTests({
        runPipeline: async () => ({ output: "", error: "no provider configured" }),
      });
      const caseId = await diagnosedClassE(root);
      await intake.resolveDiagnosedCase(caseId);
      await expect.poll(async () => (await getCase(caseId))?.status, { timeout: 5_000 }).toBe("failed");
      // Assert WHICH failure: "the pipeline run ended with an error" means the
      // real agentAvailable hook resolved the agent and the pipeline was
      // actually launched. A broken resolution fails the case too, but with
      // `the Build Studio agent "…" is not installed` — so without this the
      // test would pass either way and the hook under test wouldn't be
      // load-bearing.
      expect((await getCase(caseId))?.error).toContain("the pipeline run ended with an error");
      expect((await getCase(caseId))?.error).not.toContain("is not installed");
    } finally {
      await root.cleanup();
    }
  });

  test("a configured non-default Build Studio agent is honored", async () => {
    const root = useSelfHealTestRoot("pipeline-agent-config");
    try {
      root.writeConfig(ALL_ON);
      const { patchNamespace } = await import("../../src/lib/config/store");
      await patchNamespace("build-studio", { agent: "some-other-agent" });
      const asked: string[] = [];
      intake._setSpineAgentHooksForTests({
        agentAvailable: async (agentId) => {
          asked.push(agentId);
          return true;
        },
        runPipeline: async () => new Promise(() => {}),
      });
      const caseId = await diagnosedClassE(root);
      await intake.resolveDiagnosedCase(caseId);
      expect(asked).toEqual(["some-other-agent"]);
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("setProposedEdit", () => {
  test("attaches the reviewable edit and notes it on the timeline", async () => {
    const root = useSelfHealTestRoot("set-proposed-edit");
    try {
      const caseId = await diagnosedClassE(root);
      await intake.setProposedEdit(caseId, {
        artifactType: "skill",
        target: "agent-behavior-review",
        before: "a",
        after: "b",
      });
      const record = await getCase(caseId);
      expect(record?.proposedEdit?.target).toBe("agent-behavior-review");
      expect(record?.timeline.at(-1)?.note).toContain("agent-behavior-review");
    } finally {
      await root.cleanup();
    }
  });
});
