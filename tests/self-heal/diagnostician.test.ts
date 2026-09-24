import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import * as diag from "../../src/lib/self-heal/diagnostician";
import { createCase, getCase } from "../../src/lib/self-heal/store";
import { computeFailureSignature } from "../../src/lib/self-heal/signature";
import { useSelfHealTestRoot } from "./_test-env";
import type { TriggerContext } from "../../src/lib/self-heal/types";

// 031-self-healing FR-007/FR-008/FR-028 + FR-013's ownership predicate.
//
// `runDiagnostician` itself needs a live provider, so what is pinned here is
// everything AROUND the LLM call: the prompt actually carries the facts the
// agent cannot see for itself, the report lands in the right place with the
// right frontmatter, and the case is stamped with a routable verdict.

const ctx: TriggerContext = {
  trigger: "explicit",
  description: "the agent couldn't open the report in the Editor — bos_app_launch has no file param",
  toolName: "bos_app_launch",
  conversationId: "c-user-123",
};

async function seedCase() {
  return createCase({
    trigger: "explicit",
    title: "bos_app_launch drops file param",
    signature: computeFailureSignature(ctx),
    context: ctx,
  });
}

test.describe("buildDiagnosticianPrompt", () => {
  test("declares Mode 2 and carries the whole failure signature", async () => {
    const root = useSelfHealTestRoot("diag-prompt");
    try {
      const record = await seedCase();
      const prompt = diag.buildDiagnosticianPrompt(record, []);
      expect(prompt).toContain("Mode 2");
      expect(prompt).toContain(record.id);
      expect(prompt).toContain("bos_app_launch");
      expect(prompt).toContain("couldn't open the report in the Editor");
      expect(prompt).toContain("c-user-123");
      expect(prompt).toContain(record.signature.dedupeKey);
    } finally {
      await root.cleanup();
    }
  });

  test("tells the agent NOT to page a conversation it wasn't given", async () => {
    const root = useSelfHealTestRoot("diag-prompt-mode");
    try {
      const record = await seedCase();
      const prompt = diag.buildDiagnosticianPrompt(record, []);
      expect(prompt).toContain("conversation_overview");
      expect(prompt).toContain("FAILURE SIGNATURE, not a conversationId");
    } finally {
      await root.cleanup();
    }
  });

  test("hands over the ownership facts as authoritative, split by class", async () => {
    const root = useSelfHealTestRoot("diag-prompt-ownership");
    try {
      const record = await seedCase();
      const prompt = diag.buildDiagnosticianPrompt(record, [
        { id: "okf-knowledge-base", origin: "local", installed: true, facets: ["app", "service"] },
        { id: "public-thing", origin: "marketplace", marketplaceId: "mkt", installed: true, facets: ["app"] },
      ]);
      expect(prompt).toContain("okf-knowledge-base");
      expect(prompt).toContain("public-thing");
      expect(prompt).toContain("do not re-derive");
      // The prompt must be explicit that app_list cannot see provenance,
      // otherwise the agent will try and get it wrong.
      expect(prompt).toContain("app_list");
    } finally {
      await root.cleanup();
    }
  });

  test("names the Supervisor as off-limits", async () => {
    const root = useSelfHealTestRoot("diag-prompt-supervisor");
    try {
      const record = await seedCase();
      expect(diag.buildDiagnosticianPrompt(record, [])).toContain("tools/supervisor/**");
    } finally {
      await root.cleanup();
    }
  });

  test("renders workflow-timeout and repeated-failure context", async () => {
    const root = useSelfHealTestRoot("diag-prompt-variants");
    try {
      const wfCtx: TriggerContext = {
        trigger: "workflow-timeout",
        workflow: { id: "daily-review", node: "research", configuredMs: 10_000, actualMs: 45_000 },
        errorMessage: "timed out",
        repeated: { count: 3, windowSec: 300 },
        extra: { runId: "r-1" },
      };
      const record = await createCase({
        trigger: "workflow-timeout",
        title: "timeout",
        signature: computeFailureSignature(wfCtx),
        context: wfCtx,
      });
      const prompt = diag.buildDiagnosticianPrompt(record, []);
      expect(prompt).toContain("daily-review");
      expect(prompt).toContain("research");
      expect(prompt).toContain("3 consecutive failures within 300s");
      expect(prompt).toContain("r-1");
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("ownedItemFor (the d / d-bis predicate)", () => {
  const facts: diag.OwnershipFact[] = [
    { id: "okf-knowledge-base", origin: "local", installed: true, facets: ["app"] },
    { id: "public-thing", origin: "marketplace", marketplaceId: "mkt", installed: true, facets: ["app"] },
  ];

  test("finds a user-owned item named anywhere in the hints", () => {
    expect(ownedId(facts, "okf-knowledge-base/services/index.ts")).toBe("okf-knowledge-base");
    expect(ownedId(facts, undefined, "a bug in OKF-Knowledge-Base's ingest")).toBe("okf-knowledge-base");
  });

  test("never matches a marketplace item — that is class d, notify only", () => {
    expect(ownedId(facts, "public-thing/app/main.tsx")).toBeUndefined();
  });

  test("no hints and no match return undefined rather than a guess", () => {
    expect(ownedId(facts)).toBeUndefined();
    expect(ownedId(facts, "src/lib/self-heal/intake.ts")).toBeUndefined();
    expect(ownedId([], "okf-knowledge-base")).toBeUndefined();
  });

  function ownedId(f: diag.OwnershipFact[], ...hints: (string | undefined)[]) {
    return diag.ownedItemFor(f, ...hints)?.id;
  }
});

test.describe("storeDiagnosticsReport (FR-028)", () => {
  test("writes the markdown report to the VFS and stamps a routable verdict", async () => {
    const root = useSelfHealTestRoot("diag-store");
    try {
      const record = await seedCase();
      const { reportPath } = await diag.storeDiagnosticsReport(
        record.id,
        {
          caseId: record.id,
          scopeClass: "e",
          ownership: "bos-core",
          proposedSurface: "src/lib/assistant/tools/frontend-declarations.ts",
          verdict: "genuine gap: params is never declared",
        },
        "## Investigation\n\n`src/store/os-store.ts:11` accepts params; the tool schema does not.",
      );

      expect(reportPath).toBe(`/Documents/BOS Improvements/self-heal-${record.id}.md`);
      const onDisk = join(root.dir, "vfs", "Documents", "BOS Improvements", `self-heal-${record.id}.md`);
      expect(existsSync(onDisk)).toBe(true);
      const text = readFileSync(onDisk, "utf8");
      expect(text.startsWith("---")).toBe(true);
      expect(text).toContain("scopeClass: e");
      expect(text).toContain("ownership: bos-core");
      expect(text).toContain("os-store.ts:11");

      const after = await getCase(record.id);
      expect(after?.status).toBe("diagnosed");
      expect(after?.scopeClass).toBe("e");
      expect(after?.ownership).toBe("bos-core");
      expect(after?.proposedSurface).toBe("src/lib/assistant/tools/frontend-declarations.ts");
      expect(after?.reportPath).toBe(reportPath);
      expect(after?.verdict).toContain("genuine gap");
      expect(after?.timeline.at(-1)?.note).toContain("class e");
    } finally {
      await root.cleanup();
    }
  });

  test("carries appId through for a d-bis case", async () => {
    const root = useSelfHealTestRoot("diag-store-appid");
    try {
      const record = await seedCase();
      await diag.storeDiagnosticsReport(
        record.id,
        {
          caseId: record.id,
          scopeClass: "d-bis",
          ownership: "user-app",
          proposedSurface: "okf-knowledge-base: services/index.ts",
          appId: "okf-knowledge-base",
        },
        "## Investigation\n\nSee `src/x.ts:1`.",
      );
      expect((await getCase(record.id))?.appId).toBe("okf-knowledge-base");
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("runDiagnostician failure handling", () => {
  test.afterEach(() => {
    diag._setAgentLayerForTests(null);
  });

  test("a run that cannot produce a report fails the case instead of leaving it hanging", async () => {
    const root = useSelfHealTestRoot("diag-no-agent");
    try {
      // The run seam is stubbed to fail the way an unconfigured/unreachable
      // provider does. It used to be left real, on the assumption that "no
      // provider is configured in the temp data dir, so the headless run
      // cannot reach a model" — which was never true: src/lib/agent/llm.ts
      // builds a client with the api key "MISSING" and sends the request
      // anyway, so this test made a REAL call to whichever provider the
      // machine resolved (a developer's LAN LLM server via a module-scope
      // dataDir() capture in provider.ts, or the live Anthropic API from
      // ANTHROPIC_API_KEY). It passed only while that service happened to
      // reject it quickly, and timed out at 30s when it didn't.
      diag._setAgentLayerForTests({
        runSubAgent: async (_a, task) => ({
          agent: "Conversation Reviewer",
          type: "local",
          task,
          output: "",
          steps: 0,
          toolCalls: [],
          runId: "headless-conversation-reviewer-stub",
          endedReason: "error",
          error: "no provider configured",
        }),
      });
      const record = await seedCase();
      const outcome = await diag.runDiagnostician(record.id);
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toBeTruthy();
      const after = await getCase(record.id);
      expect(after?.status).toBe("failed");
      expect(after?.error).toBeTruthy();
    } finally {
      await root.cleanup();
    }
  });

  test("an unknown case id is reported, not thrown", async () => {
    const root = useSelfHealTestRoot("diag-no-case");
    try {
      const outcome = await diag.runDiagnostician("nope");
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toContain("nope");
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("idleConversationIds (FR-021 / design R6)", () => {
  test("returns nothing when there are no conversations", async () => {
    const root = useSelfHealTestRoot("diag-idle-empty");
    try {
      expect(await diag.idleConversationIds(300)).toEqual([]);
    } finally {
      await root.cleanup();
    }
  });

  test("picks conversations older than the threshold and skips self-heal's own", async () => {
    const root = useSelfHealTestRoot("diag-idle");
    try {
      const { mkdirSync, writeFileSync, utimesSync } = await import("fs");
      const chats = join(root.dir, "vfs", "Documents", "Chats");
      mkdirSync(chats, { recursive: true });
      const now = Date.now();
      const write = (id: string, ageMs: number) => {
        const file = join(chats, `${id}.json`);
        writeFileSync(file, JSON.stringify({ id, messages: [] }), "utf8");
        const t = (now - ageMs) / 1000;
        utimesSync(file, t, t);
      };
      write("c-old", 10 * 60_000);
      write("c-fresh", 5_000);
      write("c-self-heal-fix-0001", 10 * 60_000);

      const idle = await diag.idleConversationIds(300, now);
      expect(idle).toContain("c-old");
      expect(idle).not.toContain("c-fresh");
      // Reviewing our own runs is exactly the recursion FR-025 forbids.
      expect(idle).not.toContain("c-self-heal-fix-0001");
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("runScheduledDiagnosticianPass (FR-021)", () => {
  test.afterEach(() => {
    diag._setDiagnosticianRunnersForTests(null);
  });

  test("does nothing when the mechanism is disabled", async () => {
    const root = useSelfHealTestRoot("diag-sched-disabled");
    try {
      root.writeConfig({ enabled: false, "diagnostician.scheduled": true });
      const summary = await diag.runScheduledDiagnosticianPass();
      expect(summary.skipped).toBe(true);
      expect(summary.mode1Reviewed).toEqual([]);
      expect(summary.mode2Diagnosed).toEqual([]);
    } finally {
      await root.cleanup();
    }
  });

  test("does nothing when scheduling is off, even with the mechanism on", async () => {
    const root = useSelfHealTestRoot("diag-sched-off");
    try {
      root.writeConfig({ enabled: true, "diagnostician.scheduled": false });
      expect((await diag.runScheduledDiagnosticianPass()).skipped).toBe(true);
    } finally {
      await root.cleanup();
    }
  });

  test("defers the whole pass — and says so — when the daily cap is already spent", async () => {
    const root = useSelfHealTestRoot("diag-sched-capped");
    try {
      root.writeConfig({ enabled: true, "diagnostician.scheduled": true, costCapPerDay: 10 });
      const { appendCostLedger } = await import("../../src/lib/self-heal/store");
      await appendCostLedger({ caseId: "prior", role: "pipeline", tokens: 50, at: Date.now() });
      const summary = await diag.runScheduledDiagnosticianPass();
      expect(summary.skipped).toBe(true);
      expect(summary.errors.join(" ")).toContain("cost cap");
    } finally {
      await root.cleanup();
    }
  });

  test("reports what it deferred rather than silently truncating", async () => {
    const root = useSelfHealTestRoot("diag-sched-bounded");
    try {
      root.writeConfig({ enabled: true, "diagnostician.scheduled": true, "diagnostician.idleThresholdSec": 60 });
      const { mkdirSync, writeFileSync, utimesSync } = await import("fs");
      const chats = join(root.dir, "vfs", "Documents", "Chats");
      mkdirSync(chats, { recursive: true });
      const now = Date.now();
      for (const id of ["c-a", "c-b", "c-c", "c-d"]) {
        const file = join(chats, `${id}.json`);
        writeFileSync(file, JSON.stringify({ id, messages: [] }), "utf8");
        const t = (now - 600_000) / 1000;
        utimesSync(file, t, t);
      }
      // The one review that DOES run is stubbed: this test is about the
      // bounding and the deferral report, not about the review itself, and
      // leaving the runner real sent a live model request (see the note on
      // "a run that cannot produce a report…" above).
      diag._setDiagnosticianRunnersForTests({ mode1: async () => ({ ok: true }) });
      // maxMode1 = 1, so three are deferred and MUST be reported.
      const summary = await diag.runScheduledDiagnosticianPass({ maxMode1: 1, maxMode2: 0 });
      expect(summary.skipped).toBe(false);
      expect(summary.errors.join(" ")).toContain("deferred to the next pass");
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("the scheduled pass's deterministic behaviour (FR-021)", () => {
  test.afterEach(() => {
    diag._setDiagnosticianRunnersForTests(null);
  });

  test("runs BOTH modes in a single pass", async () => {
    const root = useSelfHealTestRoot("diag-sched-both");
    try {
      root.writeConfig({ enabled: true, "diagnostician.scheduled": true, "diagnostician.idleThresholdSec": 60 });
      const { createCase, updateCase } = await import("../../src/lib/self-heal/store");
      const pending = await createCase({
        trigger: "hard-error",
        title: "pending",
        signature: computeFailureSignature({ trigger: "hard-error", toolName: "t", errorMessage: "e" }),
        context: { trigger: "hard-error", toolName: "t", errorMessage: "e" },
      });

      const { mkdirSync, writeFileSync, utimesSync } = await import("fs");
      const chats = join(root.dir, "vfs", "Documents", "Chats");
      mkdirSync(chats, { recursive: true });
      const file = join(chats, "c-idle.json");
      writeFileSync(file, JSON.stringify({ id: "c-idle", messages: [] }), "utf8");
      const t = (Date.now() - 600_000) / 1000;
      utimesSync(file, t, t);

      diag._setDiagnosticianRunnersForTests({
        diagnose: async (caseId) => {
          await updateCase(caseId, { status: "diagnosed", scopeClass: "a", ownership: "env", proposedSurface: "disk" });
          return { ok: true, caseId, scopeClass: "a" };
        },
        mode1: async () => ({ ok: true }),
      });

      const summary = await diag.runScheduledDiagnosticianPass();
      expect(summary.skipped).toBe(false);
      expect(summary.mode2Diagnosed).toEqual([pending.id]);
      expect(summary.mode1Reviewed).toEqual(["c-idle"]);
      expect(summary.errors).toEqual([]);
      // Mode 2 routes what it diagnoses — a class-a case closes itself.
      const { getCase } = await import("../../src/lib/self-heal/store");
      expect((await getCase(pending.id))?.status).toBe("env-only");
    } finally {
      await root.cleanup();
    }
  });

  test("collects per-item errors instead of aborting the pass", async () => {
    const root = useSelfHealTestRoot("diag-sched-errors");
    try {
      root.writeConfig({ enabled: true, "diagnostician.scheduled": true, "diagnostician.idleThresholdSec": 60 });
      const { createCase } = await import("../../src/lib/self-heal/store");
      const a = await createCase({
        trigger: "hard-error",
        title: "a",
        signature: computeFailureSignature({ trigger: "hard-error", toolName: "t", errorMessage: "a" }),
        context: { trigger: "hard-error", toolName: "t", errorMessage: "a" },
      });
      const b = await createCase({
        trigger: "hard-error",
        title: "b",
        signature: computeFailureSignature({ trigger: "hard-error", toolName: "t", errorMessage: "b" }),
        context: { trigger: "hard-error", toolName: "t", errorMessage: "b" },
      });

      const { mkdirSync, writeFileSync, utimesSync } = await import("fs");
      const chats = join(root.dir, "vfs", "Documents", "Chats");
      mkdirSync(chats, { recursive: true });
      for (const id of ["c-x", "c-y"]) {
        const file = join(chats, `${id}.json`);
        writeFileSync(file, JSON.stringify({ id, messages: [] }), "utf8");
        const t = (Date.now() - 600_000) / 1000;
        utimesSync(file, t, t);
      }

      diag._setDiagnosticianRunnersForTests({
        diagnose: async (caseId) =>
          caseId === a.id ? { ok: false, caseId, error: "reported failure" } : Promise.reject(new Error("thrown failure")),
        mode1: async (conversationId) =>
          conversationId === "c-x" ? { ok: false, error: "review failed" } : Promise.reject(new Error("thrown review")),
      });

      const summary = await diag.runScheduledDiagnosticianPass({ maxMode1: 5, maxMode2: 5 });
      expect(summary.mode2Diagnosed).toEqual([]);
      expect(summary.mode1Reviewed).toEqual([]);
      const joined = summary.errors.join(" | ");
      expect(joined).toContain("reported failure");
      expect(joined).toContain("thrown failure");
      expect(joined).toContain("review failed");
      expect(joined).toContain("thrown review");
      void b;
    } finally {
      await root.cleanup();
    }
  });

  test("a Mode-1 review with no reason still reports a failure rather than counting as done", async () => {
    const root = useSelfHealTestRoot("diag-sched-silent");
    try {
      root.writeConfig({ enabled: true, "diagnostician.scheduled": true, "diagnostician.idleThresholdSec": 60 });
      const { mkdirSync, writeFileSync, utimesSync } = await import("fs");
      const chats = join(root.dir, "vfs", "Documents", "Chats");
      mkdirSync(chats, { recursive: true });
      const file = join(chats, "c-z.json");
      writeFileSync(file, JSON.stringify({ id: "c-z", messages: [] }), "utf8");
      const t = (Date.now() - 600_000) / 1000;
      utimesSync(file, t, t);

      diag._setDiagnosticianRunnersForTests({ mode1: async () => ({ ok: false }) });
      const summary = await diag.runScheduledDiagnosticianPass({ maxMode2: 0 });
      expect(summary.mode1Reviewed).toEqual([]);
      expect(summary.errors.join(" ")).toContain("review failed");
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("runMode1Review", () => {
  test.afterEach(() => {
    diag._setAgentLayerForTests(null);
  });

  test("reports a missing Diagnostician agent rather than throwing", async () => {
    const root = useSelfHealTestRoot("diag-mode1-no-agent");
    try {
      // The agent is made genuinely absent, so this asserts the branch its
      // name promises. It previously accepted EITHER outcome ("either the
      // agent is missing, or the run itself fails without a provider") and in
      // practice took the second one: the agent resolved, the run went out to
      // a real provider over the network, and the test's verdict depended on
      // how that external service happened to answer.
      diag._setAgentLayerForTests({ getAgent: async () => undefined });
      const outcome = await diag.runMode1Review("c-whatever");
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toContain("conversation-reviewer");
      expect(outcome.error).toContain("not installed");
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("ownershipFacts (the d / d-bis input)", () => {
  test("derives provenance from where the install symlink resolves", async () => {
    const root = useSelfHealTestRoot("diag-ownership");
    try {
      const { mkdirSync, writeFileSync, symlinkSync } = await import("fs");
      // A user-owned item: data/system/<id> → data/user-apps/items/<id>.
      const owned = join(root.dir, "user-apps", "items", "okf-knowledge-base");
      mkdirSync(join(owned, "app"), { recursive: true });
      writeFileSync(join(owned, "app", "index.html"), "<html></html>", "utf8");
      // A marketplace item: data/system/<id> → data/marketplace/<mkt>/items/<id>.
      const external = join(root.dir, "marketplace", "public-mkt", "items", "public-thing");
      mkdirSync(join(external, "app"), { recursive: true });
      writeFileSync(join(external, "app", "index.html"), "<html></html>", "utf8");

      mkdirSync(join(root.dir, "system"), { recursive: true });
      symlinkSync(owned, join(root.dir, "system", "okf-knowledge-base"));
      symlinkSync(external, join(root.dir, "system", "public-thing"));

      const facts = await diag.ownershipFacts();
      const byId = new Map(facts.map((f) => [f.id, f]));
      expect(byId.get("okf-knowledge-base")?.origin).toBe("local");
      expect(byId.get("okf-knowledge-base")?.facets).toContain("app");
      expect(byId.get("okf-knowledge-base")?.installed).toBe(true);
      expect(byId.get("public-thing")?.origin).toBe("marketplace");
      expect(byId.get("public-thing")?.marketplaceId).toBe("public-mkt");

      // And the predicate reads them the way the router does.
      expect(diag.ownedItemFor(facts, "okf-knowledge-base/services/index.ts")?.id).toBe("okf-knowledge-base");
      expect(diag.ownedItemFor(facts, "public-thing/app/main.tsx")).toBeUndefined();
    } finally {
      await root.cleanup();
    }
  });

  test("returns an empty list rather than throwing when nothing is installed", async () => {
    const root = useSelfHealTestRoot("diag-ownership-empty");
    try {
      expect(await diag.ownershipFacts()).toEqual([]);
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("runDiagnostician's post-run handling", () => {
  const agent = { id: "conversation-reviewer", name: "Conversation Reviewer", type: "local" as const, description: "d", systemPrompt: "p" };

  function stubRun(result: Partial<{ output: string; error: string; usage: { inputTokens: number; outputTokens: number; totalTokens: number } }>, onRun?: (task: string) => Promise<void>) {
    diag._setAgentLayerForTests({
      getAgent: async () => agent,
      runSubAgent: async (_a, task) => {
        await onRun?.(task);
        return {
          agent: agent.name,
          type: "local",
          task,
          output: result.output ?? "",
          steps: 1,
          toolCalls: [],
          runId: "headless-conversation-reviewer-stub",
          ...(result.error ? { error: result.error } : {}),
          ...(result.usage ? { usage: result.usage } : {}),
        };
      },
    });
  }

  test.afterEach(() => {
    diag._setAgentLayerForTests(null);
  });

  test("a Diagnostician run that exhausts its step budget is stopped, not failed (FR-033(b))", async () => {
    const root = useSelfHealTestRoot("diag-post-max-steps");
    try {
      // M1: `max_steps` used to arrive as an indistinguishable clean return, so
      // this run was recorded as `failed` — terminal, and silent about why.
      diag._setAgentLayerForTests({
        getAgent: async () => agent,
        runSubAgent: async (_a, task, opts) => {
          opts?.onEvent?.({
            type: "run_started",
            runId: "headless-conversation-reviewer-maxsteps",
            agentId: "conversation-reviewer",
            startedAt: new Date().toISOString(),
          });
          return {
            agent: agent.name,
            type: "local",
            task,
            output: "",
            steps: 32,
            toolCalls: [],
            runId: "headless-conversation-reviewer-maxsteps",
            endedReason: "max_steps",
          };
        },
      });
      const record = await seedCase();
      const outcome = await diag.runDiagnostician(record.id);
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toContain("step budget");
      const after = await getCase(record.id);
      expect(after?.status).toBe("stopped");
      expect(after?.stoppedFrom).toBe("diagnosing");
      expect(after?.runs?.[0]).toMatchObject({ role: "diagnostician", status: "stopped" });
    } finally {
      await root.cleanup();
    }
  });

  test("a Diagnostician run the user stopped is not re-recorded as a failure (FR-034)", async () => {
    const root = useSelfHealTestRoot("diag-post-aborted");
    try {
      diag._setAgentLayerForTests({
        getAgent: async () => agent,
        runSubAgent: async (_a, task) => ({
          agent: agent.name,
          type: "local",
          task,
          output: "",
          steps: 2,
          toolCalls: [],
          runId: "headless-conversation-reviewer-aborted",
          endedReason: "cancelled",
          aborted: true,
          error: "Cancelled by user",
        }),
      });
      const record = await seedCase();
      const outcome = await diag.runDiagnostician(record.id);
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toContain("stopped");
      // The Stop handler owns the case's state; this path must not touch it.
      expect((await getCase(record.id))?.status).toBe("diagnosing");
    } finally {
      await root.cleanup();
    }
  });

  test("the Diagnostician's tool calls are watched for a loop (FR-033)", async () => {
    const root = useSelfHealTestRoot("diag-post-stuck");
    try {
      root.writeConfig({ enabled: true, "stuckDetector.repeatCalls": 3 });
      diag._setAgentLayerForTests({
        getAgent: async () => agent,
        runSubAgent: async (_a, task, opts) => {
          opts?.onEvent?.({
            type: "run_started",
            runId: "headless-conversation-reviewer-loop",
            agentId: "conversation-reviewer",
            startedAt: new Date().toISOString(),
          });
          for (let i = 0; i < 4; i++) opts?.onEvent?.({ tool: "bos_source_search", input: { q: "file_grep" } });
          return {
            agent: agent.name,
            type: "local",
            task,
            output: "",
            steps: 4,
            toolCalls: [],
            runId: "headless-conversation-reviewer-loop",
            endedReason: "completed",
          };
        },
      });
      const record = await seedCase();
      await diag.runDiagnostician(record.id);
      const after = await getCase(record.id);
      expect(after?.stuckSignature).toMatchObject({ tool: "bos_source_search", reason: "repeat-calls" });
      expect(after?.runs?.[0].stuck?.count).toBeGreaterThanOrEqual(3);
    } finally {
      await root.cleanup();
    }
  });

  test("a missing agent fails the case with a specific reason", async () => {
    const root = useSelfHealTestRoot("diag-post-no-agent");
    try {
      diag._setAgentLayerForTests({ getAgent: async () => undefined });
      const record = await seedCase();
      const outcome = await diag.runDiagnostician(record.id);
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toContain("conversation-reviewer");
      const after = await getCase(record.id);
      expect(after?.status).toBe("failed");
      expect(after?.error).toContain("not installed");
    } finally {
      await root.cleanup();
    }
  });

  test("the happy path: the tool wrote the report, so the run's text is not parsed at all", async () => {
    const root = useSelfHealTestRoot("diag-post-tool");
    try {
      const record = await seedCase();
      stubRun({ output: "I submitted the report.", usage: { inputTokens: 900, outputTokens: 100, totalTokens: 1_000 } }, async () => {
        // What `submit_diagnostics_report` does, in the middle of the run.
        await diag.storeDiagnosticsReport(
          record.id,
          { caseId: record.id, scopeClass: "e", ownership: "bos-core", proposedSurface: "src/x.ts" },
          "## Investigation\n\nsee `src/x.ts:1`",
        );
      });

      const outcome = await diag.runDiagnostician(record.id);
      expect(outcome.ok).toBe(true);
      expect(outcome.scopeClass).toBe("e");
      expect(outcome.reportPath).toContain(record.id);
      // The run's real usage was billed to the case.
      const { getCostLedger } = await import("../../src/lib/self-heal/store");
      const ledger = await getCostLedger();
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ caseId: record.id, role: "diagnostician", tokens: 1_000 });
      expect(ledger[0].estimated).toBeUndefined();
    } finally {
      await root.cleanup();
    }
  });

  test("a failed run fails the case and still bills what it cost", async () => {
    const root = useSelfHealTestRoot("diag-post-error");
    try {
      const record = await seedCase();
      stubRun({ error: "the provider returned 500" });
      const outcome = await diag.runDiagnostician(record.id);
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toContain("the provider returned 500");
      expect((await getCase(record.id))?.status).toBe("failed");
      // No provider usage ⇒ a MARKED estimate, never a free run.
      const { getCostLedger } = await import("../../src/lib/self-heal/store");
      expect((await getCostLedger())[0].estimated).toBe(true);
    } finally {
      await root.cleanup();
    }
  });

  test("the prose fallback accepts a complete frontmatter+body answer", async () => {
    const root = useSelfHealTestRoot("diag-post-prose");
    try {
      const record = await seedCase();
      stubRun({
        output: [
          "---",
          "scopeClass: b",
          "ownership: bos-core",
          "proposedSurface: agent-behavior-review",
          "---",
          "",
          "## Investigation",
          "",
          "The skill teaches a tilde path; see `seed/skills/agent-behavior-review/SKILL.md`.",
        ].join("\n"),
      });

      const outcome = await diag.runDiagnostician(record.id);
      expect(outcome.ok).toBe(true);
      expect(outcome.scopeClass).toBe("b");
      const after = await getCase(record.id);
      expect(after?.status).toBe("diagnosed");
      expect(after?.proposedSurface).toBe("agent-behavior-review");
    } finally {
      await root.cleanup();
    }
  });

  test("prose with no usable report fails the case rather than routing a half-formed verdict", async () => {
    const root = useSelfHealTestRoot("diag-post-unusable");
    try {
      const record = await seedCase();
      stubRun({ output: "I think it might be somewhere in the tool layer." });
      const outcome = await diag.runDiagnostician(record.id);
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toContain("did not submit a usable report");
      const after = await getCase(record.id);
      expect(after?.status).toBe("failed");
      expect(after?.scopeClass).toBeUndefined();
    } finally {
      await root.cleanup();
    }
  });

  test("the run is given the marked, brief-seeded conversation", async () => {
    const root = useSelfHealTestRoot("diag-post-conversation");
    try {
      const record = await seedCase();
      const seen: (string | undefined)[] = [];
      diag._setAgentLayerForTests({
        getAgent: async () => agent,
        runSubAgent: async (_a, task, opts) => {
          seen.push(opts?.conversationId);
          return {
            agent: agent.name,
            type: "local",
            task,
            output: "",
            steps: 0,
            toolCalls: [],
            runId: "headless-conversation-reviewer-stub",
            error: "stop here",
          };
        },
      });
      await diag.runDiagnostician(record.id);
      expect(seen).toEqual([diag.diagnosticianConversationId(record.id)]);

      const { getSelfHealConversationMarker } = await import("../../src/lib/self-heal/reentrancy");
      expect(await getSelfHealConversationMarker(diag.diagnosticianConversationId(record.id))).toEqual({
        role: "diagnostician",
        caseId: record.id,
      });
    } finally {
      await root.cleanup();
    }
  });

  test("ownershipFacts survives an unreadable install root", async () => {
    const root = useSelfHealTestRoot("diag-ownership-broken");
    try {
      const { writeFileSync, mkdirSync } = await import("fs");
      mkdirSync(root.dir, { recursive: true });
      // `data/system` as a FILE makes the scan throw.
      writeFileSync(join(root.dir, "system"), "not a directory", "utf8");
      expect(await diag.ownershipFacts()).toEqual([]);
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("ensureScheduledDiagnosticianJob (FR-021)", () => {
  test("seeds a recurring system job owned by self-heal, ticking at the idle threshold", async () => {
    const root = useSelfHealTestRoot("diag-job");
    try {
      root.writeConfig({ enabled: true, "diagnostician.scheduled": true, "diagnostician.idleThresholdSec": 600 });
      await diag.ensureScheduledDiagnosticianJob();

      const { getJob, invalidateCache } = await import("../../src/lib/scheduler/engine");
      invalidateCache();
      const job = await getJob(diag.SELF_HEAL_SCHEDULER_JOB_ID);
      expect(job?.owner).toBe(diag.SELF_HEAL_SCHEDULER_OWNER);
      expect(job?.category).toBe("system");
      expect(job?.handler).toEqual({ kind: "internal", ref: diag.SELF_HEAL_SCHEDULER_REF });
      expect(job?.scheduleConfig).toEqual({ type: "recurring", interval: 10, unit: "minute" });
      expect(job?.readOnlyFields).toEqual(["handler"]);
    } finally {
      await root.cleanup();
    }
  });

  test("is idempotent and never ticks faster than once a minute", async () => {
    const root = useSelfHealTestRoot("diag-job-idempotent");
    try {
      root.writeConfig({ enabled: true, "diagnostician.idleThresholdSec": 30 });
      await diag.ensureScheduledDiagnosticianJob();
      await diag.ensureScheduledDiagnosticianJob();

      const { listJobs, invalidateCache } = await import("../../src/lib/scheduler/engine");
      invalidateCache();
      const mine = (await listJobs()).filter((j) => j.id === diag.SELF_HEAL_SCHEDULER_JOB_ID);
      expect(mine).toHaveLength(1);
      expect(mine[0].scheduleConfig).toEqual({ type: "recurring", interval: 1, unit: "minute" });
    } finally {
      await root.cleanup();
    }
  });

  test("the registered internal handler reports the pass's outcome to the scheduler", async () => {
    const root = useSelfHealTestRoot("diag-job-handler");
    try {
      root.writeConfig({ enabled: true, "diagnostician.scheduled": false });
      await diag.ensureScheduledDiagnosticianJob();

      const { getJob, runJobNow, listHistory, invalidateCache } = await import("../../src/lib/scheduler/engine");
      invalidateCache();
      const job = await getJob(diag.SELF_HEAL_SCHEDULER_JOB_ID);
      if (!job) throw new Error("the job was not seeded");
      await runJobNow(job);
      const history = await listHistory(job.id);
      expect(history.at(-1)?.status).toBe("success");
      // Scheduling is off, so the pass reports that it did nothing — rather
      // than silently succeeding as if it had reviewed something.
      expect(history.at(-1)?.output).toContain("disabled");
    } finally {
      await root.cleanup();
    }
  });

  test("the handler surfaces a pass's errors as a job error", async () => {
    const root = useSelfHealTestRoot("diag-job-handler-error");
    try {
      root.writeConfig({ enabled: true, "diagnostician.scheduled": true, "diagnostician.idleThresholdSec": 60 });
      const { createCase } = await import("../../src/lib/self-heal/store");
      await createCase({
        trigger: "hard-error",
        title: "pending",
        signature: computeFailureSignature({ trigger: "hard-error", toolName: "t", errorMessage: "e" }),
        context: { trigger: "hard-error", toolName: "t", errorMessage: "e" },
      });
      diag._setDiagnosticianRunnersForTests({ diagnose: async (caseId) => ({ ok: false, caseId, error: "nope" }) });
      await diag.ensureScheduledDiagnosticianJob();

      const { getJob, runJobNow, listHistory, invalidateCache } = await import("../../src/lib/scheduler/engine");
      invalidateCache();
      const job = await getJob(diag.SELF_HEAL_SCHEDULER_JOB_ID);
      if (!job) throw new Error("the job was not seeded");
      await runJobNow(job);
      const last = await listHistory(job.id).then((h) => h.at(-1));
      expect(last?.status).toBe("error");
      expect(last?.error).toContain("nope");
    } finally {
      diag._setDiagnosticianRunnersForTests(null);
      await root.cleanup();
    }
  });
});
