import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import * as intake from "../../src/lib/self-heal/intake";
import { buildAutonomousBrief, buildResumeBrief } from "../../src/lib/self-heal/brief";
import { triggerContextFromEvent } from "../../src/lib/self-heal/spine-handler";
import { createCase, getCase, listCases, readIndex, updateCase, withIndex } from "../../src/lib/self-heal/store";
import { computeFailureSignature } from "../../src/lib/self-heal/signature";
import { SELF_HEAL_DEFAULTS, selfHealBranchFor } from "../../src/lib/self-heal/types";
import { useSelfHealTestRoot } from "./_test-env";
import type { EventRecord } from "../../src/lib/events/types";
import type { TriggerContext } from "../../src/lib/self-heal/types";

// Degraded-input paths across the spine.
//
// Every assertion here is "the interesting thing is MISSING": a case with no
// report, an event with no payload, a resume with no recorded question, a fix
// with an app instead of a branch. These are the paths a happy-path run never
// touches and the ones a real deployment hits first, so they get their own file
// rather than being smuggled into the feature tests.

const HARD: TriggerContext = { trigger: "hard-error", toolName: "t", errorMessage: "e" };
const ALL_ON = { enabled: true, "triggers.explicit": true, "triggers.hardError": true, "triggers.logEvents": true };

async function bareCase(scopeClass?: "e" | "d-bis") {
  const record = await createCase({ trigger: "hard-error", title: "t", signature: computeFailureSignature(HARD), context: HARD });
  if (scopeClass) await updateCase(record.id, { status: "diagnosed", scopeClass, ownership: scopeClass === "e" ? "bos-core" : "user-app" });
  return (await getCase(record.id))!;
}

test.afterEach(() => {
  intake._setSpineAgentHooksForTests(null);
});

test.describe("the brief with nothing filled in", () => {
  test("a class-e case with no report, no surface and no branch still produces a usable brief", async () => {
    const root = useSelfHealTestRoot("edge-brief-bare");
    try {
      const record = await bareCase("e");
      const brief = buildAutonomousBrief({ record, cfg: SELF_HEAL_DEFAULTS, reportBody: "" });
      expect(brief).toContain("(see the case record)");
      expect(brief).toContain("(see the report)");
      // The branch is DERIVED when the caller didn't pass one — the agent must
      // never be told to work on an unnamed branch.
      expect(brief).toContain(selfHealBranchFor(record.id));
    } finally {
      await root.cleanup();
    }
  });

  test("a class-d-bis case with no appId says where to find it rather than inventing one", async () => {
    const root = useSelfHealTestRoot("edge-brief-no-appid");
    try {
      const record = await bareCase("d-bis");
      const brief = buildAutonomousBrief({ record, cfg: SELF_HEAL_DEFAULTS, reportBody: "" });
      expect(brief).toContain("(the item id from the report)");
      expect(brief).toContain("app_build");
    } finally {
      await root.cleanup();
    }
  });

  test("a resume brief for a case whose question was never recorded says so", async () => {
    const root = useSelfHealTestRoot("edge-brief-no-question");
    try {
      const record = await bareCase("e");
      const brief = buildResumeBrief(record, "do the first one");
      expect(brief).toContain("(question not recorded)");
      expect(brief).toContain("do the first one");
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("event payloads with pieces missing", () => {
  function evt(payload: unknown): EventRecord {
    return {
      id: "e-1",
      type: "com.bos.self-heal.trigger",
      payload: payload as Record<string, unknown>,
      source: { appId: "x", name: "X" },
      ts: Date.now(),
      sequence: 1,
      summary: "s",
    };
  }

  test("an event with NO payload at all is treated as a bare explicit report", () => {
    const ctx = triggerContextFromEvent(evt(undefined));
    expect(ctx?.trigger).toBe("explicit");
    expect(ctx?.eventId).toBe("e-1");
  });

  test("a workflow event supplies its own error message when it has one", () => {
    const ctx = triggerContextFromEvent(evt({ workflowId: "wf", errorMessage: "node research stalled" }));
    expect(ctx?.errorMessage).toBe("node research stalled");
    // No node reported ⇒ the field is omitted rather than set to undefined.
    expect(ctx?.workflow).toEqual({ id: "wf" });
  });

  test("a workflow event with no message gets the standard one", () => {
    expect(triggerContextFromEvent(evt({ workflowId: "wf" }))?.errorMessage).toContain("exceeded its configured timeout");
  });

  test("a log event is recognized from `level: error` alone, with no declared trigger", () => {
    const ctx = triggerContextFromEvent(evt({ component: "scheduler.executor", level: "error", message: "job wedged", code: "EWEDGED" }));
    expect(ctx?.trigger).toBe("log-events");
    expect(ctx?.errorMessage).toBe("job wedged");
    expect(ctx?.errorCode).toBe("EWEDGED");
  });

  test("a log event with only errorMessage, and one with neither, both map", () => {
    expect(triggerContextFromEvent(evt({ trigger: "log-events", component: "events", errorMessage: "kernel refused" }))?.errorMessage).toBe(
      "kernel refused",
    );
    expect(triggerContextFromEvent(evt({ trigger: "log-events", component: "events" }))?.errorMessage).toBe("error-level log event");
  });
});

test.describe("intake front-door degraded inputs", () => {
  test("a log trigger with no component names the empty component in its reason", async () => {
    const root = useSelfHealTestRoot("edge-intake-no-component");
    try {
      root.writeConfig(ALL_ON);
      const outcome = await intake.selfHealIntake({ trigger: "log-events", errorMessage: "x" }, { awaitDiagnosis: true });
      expect(outcome.action).toBe("not-bos-owned");
      if (outcome.action === "not-bos-owned") expect(outcome.reason).toContain('""');
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("routing degraded cases", () => {
  test("a class-b case WITH a proposed edit names it on the timeline", async () => {
    const root = useSelfHealTestRoot("edge-route-b-edit");
    try {
      root.writeConfig(ALL_ON);
      const record = await bareCase();
      await updateCase(record.id, {
        status: "diagnosed",
        scopeClass: "b",
        ownership: "bos-core",
        proposedEdit: { artifactType: "skill", target: "agent-behavior-review", before: "a", after: "b" },
      });
      await intake.resolveDiagnosedCase(record.id);
      const after = await getCase(record.id);
      expect(after?.status).toBe("awaiting-consent");
      expect(after?.timeline.at(-1)?.note).toContain("agent-behavior-review");
    } finally {
      await root.cleanup();
    }
  });

  test("an app case with no diagnosed appId falls back to the trigger's own appId in the notice", async () => {
    const root = useSelfHealTestRoot("edge-route-d-appid");
    try {
      root.writeConfig(ALL_ON);
      const ctx: TriggerContext = { trigger: "hard-error", toolName: "t", errorMessage: "e", appId: "public-thing" };
      const record = await createCase({ trigger: "hard-error", title: "t", signature: computeFailureSignature(ctx), context: ctx });
      await updateCase(record.id, { status: "diagnosed", scopeClass: "d", ownership: "marketplace" });
      const outcome = await intake.resolveDiagnosedCase(record.id);
      expect(outcome.action).toBe("notified");
    } finally {
      await root.cleanup();
    }
  });

  test("a d-bis diagnosis for a genuinely OWNED app is escalated (SC-004)", async () => {
    const root = useSelfHealTestRoot("edge-route-dbis-owned");
    try {
      root.writeConfig(ALL_ON);
      const { mkdirSync, writeFileSync, symlinkSync } = await import("fs");
      const owned = join(root.dir, "user-apps", "items", "okf-knowledge-base");
      mkdirSync(join(owned, "app"), { recursive: true });
      writeFileSync(join(owned, "app", "index.html"), "<html></html>", "utf8");
      mkdirSync(join(root.dir, "system"), { recursive: true });
      symlinkSync(owned, join(root.dir, "system", "okf-knowledge-base"));

      const launched: { featureBranch?: string }[] = [];
      intake._setSpineAgentHooksForTests({
        agentAvailable: async () => true,
        runPipeline: async (input) => {
          launched.push({ featureBranch: input.featureBranch });
          return new Promise(() => {});
        },
      });

      const record = await bareCase();
      await updateCase(record.id, {
        status: "diagnosed",
        scopeClass: "d-bis",
        ownership: "user-app",
        proposedSurface: "okf-knowledge-base: services/index.ts",
      });
      const outcome = await intake.resolveDiagnosedCase(record.id);
      expect(outcome.action).toBe("escalated");
      const after = await getCase(record.id);
      expect(after?.scopeClass).toBe("d-bis");
      expect(after?.appId).toBe("okf-knowledge-base");
      expect(after?.status).toBe("bs-pipeline");
      // app_build delivery ⇒ no BOS-source feature branch (SC-004).
      expect(launched[0].featureBranch).toBeUndefined();
    } finally {
      await root.cleanup();
    }
  });

  test("escalating an unknown or already-terminal case is refused", async () => {
    const root = useSelfHealTestRoot("edge-escalate-refused");
    try {
      root.writeConfig(ALL_ON);
      expect((await intake.escalateCase("nope")).action).toBe("skipped");
      const record = await bareCase("e");
      await updateCase(record.id, { status: "dismissed" });
      const outcome = await intake.escalateCase(record.id);
      expect(outcome.action).toBe("skipped");
      if (outcome.action === "skipped") expect(outcome.reason).toContain("dismissed");
    } finally {
      await root.cleanup();
    }
  });

  test("a case id that cannot form a valid branch fails loudly instead of running unbranched", async () => {
    const root = useSelfHealTestRoot("edge-bad-branch");
    try {
      root.writeConfig(ALL_ON);
      intake._setSpineAgentHooksForTests({ agentAvailable: async () => true, runPipeline: async () => new Promise(() => {}) });
      // Hand-write a case whose id would produce `bos/self-heal-bad_id` — an
      // underscore is not a legal branch segment. Nothing in BOS mints such an
      // id, so this is the guard, not the normal path.
      const { writeFileSync, mkdirSync } = await import("fs");
      const seed = await bareCase("e");
      const raw = await getCase(seed.id);
      if (!raw) throw new Error("missing case");
      const bad = { ...raw, id: "BAD_ID" };
      mkdirSync(join(root.dir, "self-heal", "cases"), { recursive: true });
      writeFileSync(join(root.dir, "self-heal", "cases", "BAD_ID.json"), JSON.stringify(bad), "utf8");
      await withIndex((index) => {
        index.cases["BAD_ID"] = { status: "diagnosed", updatedAt: Date.now() };
      });

      const outcome = await intake.escalateCase("BAD_ID");
      expect(outcome.action).toBe("skipped");
      expect((await getCase("BAD_ID"))?.status).toBe("failed");
      expect((await getCase("BAD_ID"))?.error).toContain("not a valid feature branch");
      expect((await readIndex()).inFlightSlowPathCaseId).toBeNull();
    } finally {
      await root.cleanup();
    }
  });

  test("a misconfigured Build Studio agent id fails the case through the REAL hooks", async () => {
    const root = useSelfHealTestRoot("edge-bad-agent");
    try {
      root.writeConfig(ALL_ON);
      const { patchNamespace } = await import("../../src/lib/config/store");
      await patchNamespace("build-studio", { agent: "no-such-agent" });
      const record = await bareCase("e");
      const outcome = await intake.escalateCase(record.id);
      expect(outcome.action).toBe("skipped");
      expect((await getCase(record.id))?.error).toContain("no-such-agent");
    } finally {
      await root.cleanup();
    }
  });

  test("an unreadable build-studio config falls back to the default agent id", async () => {
    const root = useSelfHealTestRoot("edge-agent-fallback");
    try {
      root.writeConfig(ALL_ON);
      const { writeFileSync } = await import("fs");
      writeFileSync(join(root.dir, "config", "build-studio.json"), "{ not json", "utf8");
      const asked: string[] = [];
      intake._setSpineAgentHooksForTests({
        agentAvailable: async (id) => {
          asked.push(id);
          return false;
        },
      });
      const record = await bareCase("e");
      await intake.escalateCase(record.id);
      expect(asked).toEqual(["build-studio"]);
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("resume and completion with pieces missing", () => {
  test("a suspended case with no recorded conversation resumes on the derived one", async () => {
    const root = useSelfHealTestRoot("edge-resume-no-conversation");
    try {
      root.writeConfig(ALL_ON);
      const seen: { conversationId: string; featureBranch?: string }[] = [];
      intake._setSpineAgentHooksForTests({
        agentAvailable: async () => true,
        runPipeline: async (input) => {
          seen.push({ conversationId: input.conversationId, featureBranch: input.featureBranch });
          return new Promise(() => {});
        },
      });
      const record = await bareCase("e");
      await updateCase(record.id, { status: "suspended", pendingQuestion: "A or B?" });
      await intake.resumeCase(record.id, "A");
      expect(seen[0].conversationId).toBe(intake.pipelineConversationId(record.id));
      // No branch was ever set on this case, so none is forced onto the run.
      expect(seen[0].featureBranch).toBeUndefined();
    } finally {
      await root.cleanup();
    }
  });

  test("completing a class-d-bis fix reports the app, not a branch", async () => {
    const root = useSelfHealTestRoot("edge-complete-app");
    try {
      root.writeConfig(ALL_ON);
      const record = await bareCase("d-bis");
      await updateCase(record.id, { status: "bs-pipeline", appId: "okf-knowledge-base" });
      const outcome = await intake.completeFix({ caseId: record.id, summary: "Rebuilt the ingest handler." });
      expect(outcome.ok).toBe(true);
      const after = await getCase(record.id);
      expect(after?.status).toBe("preview-ready");
      expect(after?.appId).toBe("okf-knowledge-base");
      expect(after?.activeFeatureBranch).toBeUndefined();
      // No branch ⇒ no preview deep link is invented.
      expect(after?.fixLink).toBeUndefined();
      expect(after?.timeline.at(-1)?.note).toContain("okf-knowledge-base");
    } finally {
      await root.cleanup();
    }
  });

  test("an explicit link is used instead of the derived one", async () => {
    const root = useSelfHealTestRoot("edge-complete-link");
    try {
      root.writeConfig(ALL_ON);
      const record = await bareCase("e");
      await updateCase(record.id, { status: "bs-pipeline", activeFeatureBranch: selfHealBranchFor(record.id) });
      await intake.completeFix({ caseId: record.id, summary: "s", link: "/custom/link" });
      expect((await getCase(record.id))?.fixLink).toBe("/custom/link");
    } finally {
      await root.cleanup();
    }
  });

  test("a pipeline run whose case was deleted mid-flight is a no-op", async () => {
    const root = useSelfHealTestRoot("edge-run-ended-deleted");
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
      const record = await bareCase("e");
      await intake.escalateCase(record.id);
      const { rmSync } = await import("fs");
      rmSync(join(root.dir, "self-heal", "cases", `${record.id}.json`), { force: true });
      settle?.();
      await new Promise((r) => setTimeout(r, 50));
      expect(await getCase(record.id)).toBeUndefined();
    } finally {
      await root.cleanup();
    }
  });

  test("reconcile keeps an existing fix summary rather than overwriting it", async () => {
    const root = useSelfHealTestRoot("edge-reconcile-summary");
    const previous = process.env.BOS_SUPERVISOR_URL;
    const http = await import("node:http");
    let branch = "";
    const server = http.createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ previews: [{ role: "preview", branch, state: "ready" }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    process.env.BOS_SUPERVISOR_URL = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    try {
      root.writeConfig(ALL_ON);
      const record = await bareCase("e");
      branch = selfHealBranchFor(record.id);
      await updateCase(record.id, {
        status: "bs-pipeline",
        activeFeatureBranch: branch,
        fixSummary: "the summary the agent already wrote",
      });
      await intake.reconcileInFlightCases();
      expect((await getCase(record.id))?.fixSummary).toBe("the summary the agent already wrote");
    } finally {
      server.close();
      if (previous === undefined) delete process.env.BOS_SUPERVISOR_URL;
      else process.env.BOS_SUPERVISOR_URL = previous;
      await root.cleanup();
    }
  });

  test("previewStateFor tolerates a Supervisor that answers with nonsense", async () => {
    const root = useSelfHealTestRoot("edge-preview-nonsense");
    const previous = process.env.BOS_SUPERVISOR_URL;
    const http = await import("node:http");
    const server = http.createServer((_req, res) => res.end("<html>not json</html>"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    process.env.BOS_SUPERVISOR_URL = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    try {
      expect(await intake.previewStateFor("bos/self-heal-0001")).toBeUndefined();
    } finally {
      server.close();
      if (previous === undefined) delete process.env.BOS_SUPERVISOR_URL;
      else process.env.BOS_SUPERVISOR_URL = previous;
      await root.cleanup();
    }
  });

  test("reconcile releases a slot still held by a case that already went terminal", async () => {
    const root = useSelfHealTestRoot("edge-reconcile-stale-slot");
    try {
      root.writeConfig(ALL_ON);
      const record = await bareCase("e");
      await updateCase(record.id, { status: "preview-ready" });
      await withIndex((index) => {
        index.inFlightSlowPathCaseId = record.id;
      });
      await intake.reconcileInFlightCases();
      expect((await readIndex()).inFlightSlowPathCaseId).toBeNull();
      expect(await listCases()).toHaveLength(1);
    } finally {
      await root.cleanup();
    }
  });
});
