import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { registerSelfHealSpine, SELF_HEAL_HANDLER_ID, _resetSpineRegistrationForTests } from "../../src/lib/self-heal/spine-handler";
import * as intake from "../../src/lib/self-heal/intake";
import { getCase, listCases, updateCase, withIndex, selfHealDir } from "../../src/lib/self-heal/store";
import { storeDiagnosticsReport } from "../../src/lib/self-heal/diagnostician";
import { computeFailureSignature } from "../../src/lib/self-heal/signature";
import { createCase } from "../../src/lib/self-heal/store";
import { SELF_HEAL_EVENTS, SELF_HEAL_EVENT_NAMESPACE, selfHealBranchFor } from "../../src/lib/self-heal/types";
import { useSelfHealTestRoot } from "./_test-env";
import type { EventRecord } from "../../src/lib/events/types";
import type { TriggerContext } from "../../src/lib/self-heal/types";

// 031-self-healing — the 034 core headless handler that fronts the spine
// (design ADR-1).
//
// The spine has to react to EVENTS, which is exactly why it is neither a
// scheduler job (time-based only) nor a 002 workflow service (no
// deterministic-code node, no event-triggered runs). These tests drive the
// registered executor directly, which is what the kernel does.

const HARD: TriggerContext = { trigger: "hard-error", toolName: "file_read", errorMessage: "permission denied" };
const ALL_ON = {
  enabled: true,
  "triggers.explicit": true,
  "triggers.hardError": true,
  "triggers.repeatedFailure": true,
  "triggers.workflowTimeout": true,
  "triggers.logEvents": true,
};

function evt(type: string, payload: Record<string, unknown>): EventRecord {
  return { id: `e-${Math.random().toString(36).slice(2)}`, type, payload, source: { appId: "t", name: "T" }, ts: Date.now(), sequence: 1, summary: "s" };
}

/** The executor the kernel would call, taken from the dispatch registry the
 *  spine registers itself into. */
async function executor() {
  const dispatch = await import("../../src/lib/events/dispatch");
  const g = globalThis as unknown as {
    __bosEventDispatch?: { coreExecutors: Map<string, (r: EventRecord) => Promise<{ result?: unknown } | void>> };
  };
  void dispatch;
  const fn = g.__bosEventDispatch?.coreExecutors.get(SELF_HEAL_HANDLER_ID);
  if (!fn) throw new Error("the spine handler is not registered");
  return fn;
}

test.beforeEach(() => {
  _resetSpineRegistrationForTests();
});

test.afterEach(() => {
  intake._setSpineAgentHooksForTests(null);
});

test.describe("registration", () => {
  test("registers ONE core headless handler for the whole self-heal namespace", async () => {
    const root = useSelfHealTestRoot("spine-register");
    try {
      await registerSelfHealSpine();
      const api = await import("../../src/lib/events/api");
      const grouped = api.listHandlersGrouped();
      const group = grouped[SELF_HEAL_EVENT_NAMESPACE];
      expect(group).toBeTruthy();
      // The registration is HEADLESS (it is in the headless bucket) and owned
      // by core, which is what makes it active without a running service.
      const registered = (group?.headless ?? []).find((h) => h.handlerId === SELF_HEAL_HANDLER_ID);
      expect(registered).toBeTruthy();
      expect(registered?.ownerId).toBe("core");
      expect(registered?.enabled).toBe(true);
      expect(await executor()).toBeTruthy();
    } finally {
      await root.cleanup();
    }
  });

  test("is idempotent — a second call re-installs the executor without a duplicate registration", async () => {
    const root = useSelfHealTestRoot("spine-register-twice");
    try {
      await registerSelfHealSpine();
      await registerSelfHealSpine();
      const api = await import("../../src/lib/events/api");
      const group = api.listHandlersGrouped()[SELF_HEAL_EVENT_NAMESPACE];
      const mine = (group?.headless ?? []).filter((h) => h.handlerId === SELF_HEAL_HANDLER_ID);
      expect(mine).toHaveLength(1);
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("trigger events", () => {
  test("a hard-error trigger event creates a case and the handler acks immediately", async () => {
    const root = useSelfHealTestRoot("spine-trigger");
    try {
      root.writeConfig(ALL_ON);
      intake._setSpineAgentHooksForTests({ diagnose: async () => ({ ok: false }) });
      await registerSelfHealSpine();
      const run = await executor();

      const out = (await run(evt(SELF_HEAL_EVENTS.trigger, { ...HARD, trigger: "hard-error" }))) as {
        result?: { action?: string };
      };
      expect(out.result?.action).toBe("created");
      expect(await listCases()).toHaveLength(1);
    } finally {
      await root.cleanup();
    }
  });

  test("a trigger with no recognizable failure is acked and ignored, not retried forever", async () => {
    const root = useSelfHealTestRoot("spine-trigger-empty");
    try {
      root.writeConfig({ ...ALL_ON, "triggers.logEvents": true });
      await registerSelfHealSpine();
      const run = await executor();
      const out = (await run(evt(SELF_HEAL_EVENTS.trigger, { trigger: "log-events" }))) as {
        result?: { ignored?: string };
      };
      expect(out.result?.ignored).toContain("no recognizable failure");
      expect(await listCases()).toEqual([]);
    } finally {
      await root.cleanup();
    }
  });

  test("a log event from a non-BOS component is refused at the handler", async () => {
    const root = useSelfHealTestRoot("spine-trigger-not-owned");
    try {
      root.writeConfig(ALL_ON);
      await registerSelfHealSpine();
      const run = await executor();
      const out = (await run(
        evt(SELF_HEAL_EVENTS.trigger, { trigger: "log-events", component: "okf-knowledge-base", message: "boom", level: "error" }),
      )) as { result?: { ignored?: string } };
      expect(out.result?.ignored).toContain("not BOS-owned");
      expect(await listCases()).toEqual([]);
    } finally {
      await root.cleanup();
    }
  });

  test("a workflow-timeout event maps onto the trigger context (FR-004)", async () => {
    const root = useSelfHealTestRoot("spine-trigger-workflow");
    try {
      root.writeConfig(ALL_ON);
      intake._setSpineAgentHooksForTests({ diagnose: async () => ({ ok: false }) });
      await registerSelfHealSpine();
      const run = await executor();
      await run(evt(SELF_HEAL_EVENTS.trigger, { trigger: "workflow-timeout", workflowId: "daily-review", node: "research", configuredMs: 10_000, actualMs: 42_000 }));

      const [record] = await listCases();
      expect(record.trigger).toBe("workflow-timeout");
      expect(record.context.workflow?.id).toBe("daily-review");
    } finally {
      await root.cleanup();
    }
  });

  test("the re-entrancy filter runs at the handler too", async () => {
    const root = useSelfHealTestRoot("spine-trigger-reentrancy");
    try {
      root.writeConfig(ALL_ON);
      await registerSelfHealSpine();
      const run = await executor();
      const out = (await run(
        evt(SELF_HEAL_EVENTS.trigger, { ...HARD, trigger: "hard-error", selfHeal: { role: "lifecycle", caseId: "0001" } }),
      )) as { result?: { action?: string } };
      expect(out.result?.action).toBe("reentrancy-skipped");
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("decision_resolved events (FR-016 / C5)", () => {
  test("resumes the suspended case", async () => {
    const root = useSelfHealTestRoot("spine-resolved");
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
      const record = await createCase({
        trigger: "hard-error",
        title: "t",
        signature: computeFailureSignature(HARD),
        context: HARD,
      });
      await storeDiagnosticsReport(
        record.id,
        { caseId: record.id, scopeClass: "e", ownership: "bos-core", proposedSurface: "src/x.ts" },
        "## Investigation\n\nsee `src/x.ts:1`",
      );
      await updateCase(record.id, {
        status: "suspended",
        conversationId: `c-self-heal-fix-${record.id}`,
        activeFeatureBranch: selfHealBranchFor(record.id),
        pendingQuestion: "A or B?",
      });

      await registerSelfHealSpine();
      const run = await executor();
      const out = (await run(evt(SELF_HEAL_EVENTS.decisionResolved, { caseId: record.id, answer: "A" }))) as {
        result?: { resumed?: string | null; status?: string | null };
      };
      expect(out.result?.resumed).toBe(record.id);
      expect(out.result?.status).toBe("bs-pipeline");
      expect((await getCase(record.id))?.decisionAnswer).toBe("A");
      expect(launched).toEqual([record.id]);
    } finally {
      await root.cleanup();
    }
  });

  test("an incomplete decision_resolved is acked and ignored", async () => {
    const root = useSelfHealTestRoot("spine-resolved-incomplete");
    try {
      root.writeConfig(ALL_ON);
      await registerSelfHealSpine();
      const run = await executor();
      for (const payload of [{}, { caseId: "0001" }, { answer: "A" }]) {
        const out = (await run(evt(SELF_HEAL_EVENTS.decisionResolved, payload))) as { result?: { ignored?: string } };
        expect(out.result?.ignored).toContain("caseId and answer");
      }
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("the spine's own lifecycle events", () => {
  test("are acked and ignored — acting on our own notifications IS the recursion FR-025 forbids", async () => {
    const root = useSelfHealTestRoot("spine-lifecycle");
    try {
      root.writeConfig(ALL_ON);
      await registerSelfHealSpine();
      const run = await executor();
      for (const type of [SELF_HEAL_EVENTS.caseCreated, SELF_HEAL_EVENTS.fixReady, SELF_HEAL_EVENTS.dedupeSuppressed]) {
        const out = (await run(evt(type, { caseId: "0001" }))) as { result?: { ignored?: string } };
        expect(out.result?.ignored).toContain("no spine action");
      }
      expect(await listCases()).toEqual([]);
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("handler failures", () => {
  test("a throwing handler rethrows so the kernel can retry (intake is idempotent)", async () => {
    const root = useSelfHealTestRoot("spine-throws");
    try {
      root.writeConfig(ALL_ON);
      intake._setSpineAgentHooksForTests({
        diagnose: async () => {
          throw new Error("diagnose exploded");
        },
      });
      await registerSelfHealSpine();
      const run = await executor();
      // Make the store unwritable so intake itself fails inside the handler.
      const { rmSync, writeFileSync } = await import("fs");
      rmSync(selfHealDir(), { recursive: true, force: true });
      writeFileSync(selfHealDir(), "not a directory", "utf8");
      await expect(run(evt(SELF_HEAL_EVENTS.trigger, { ...HARD, trigger: "hard-error" }))).rejects.toThrow();
    } finally {
      const { rmSync } = await import("fs");
      rmSync(selfHealDir(), { force: true });
      await root.cleanup();
    }
  });
});

test.describe("selfHealDir", () => {
  test("points inside the active data dir", async () => {
    const root = useSelfHealTestRoot("spine-dir");
    try {
      await withIndex(() => undefined);
      expect(selfHealDir()).toBe(`${root.dir}/self-heal`);
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("handler degraded inputs", () => {
  test("a decision_resolved with no payload at all is acked and ignored", async () => {
    const root = useSelfHealTestRoot("spine-resolved-nopayload");
    try {
      root.writeConfig(ALL_ON);
      await registerSelfHealSpine();
      const run = await executor();
      const bare = { ...evt(SELF_HEAL_EVENTS.decisionResolved, {}), payload: undefined as unknown as Record<string, unknown> };
      const out = (await run(bare)) as { result?: { ignored?: string } };
      expect(out.result?.ignored).toContain("caseId and answer");
    } finally {
      await root.cleanup();
    }
  });

  test("a decision_resolved for a case that no longer exists reports null, not a crash", async () => {
    const root = useSelfHealTestRoot("spine-resolved-missing-case");
    try {
      root.writeConfig(ALL_ON);
      await registerSelfHealSpine();
      const run = await executor();
      const out = (await run(evt(SELF_HEAL_EVENTS.decisionResolved, { caseId: "9999", answer: "A" }))) as {
        result?: { resumed?: string | null; status?: string | null };
      };
      expect(out.result?.resumed).toBeNull();
      expect(out.result?.status).toBeNull();
    } finally {
      await root.cleanup();
    }
  });

  test("a log-shaped trigger with no component is refused at the handler with the empty name shown", async () => {
    const root = useSelfHealTestRoot("spine-log-no-component");
    try {
      root.writeConfig(ALL_ON);
      await registerSelfHealSpine();
      const run = await executor();
      // `trigger: log-events` with no component maps to undefined, which the
      // handler rejects before intake even sees it.
      const out = (await run(evt(SELF_HEAL_EVENTS.trigger, { trigger: "log-events", message: "x" }))) as {
        result?: { ignored?: string };
      };
      expect(out.result?.ignored).toBeTruthy();
    } finally {
      await root.cleanup();
    }
  });

  test("a workflow trigger with a node reported on the nested object keeps it", async () => {
    const root = useSelfHealTestRoot("spine-workflow-nested-node");
    try {
      root.writeConfig(ALL_ON);
      intake._setSpineAgentHooksForTests({ diagnose: async () => ({ ok: false }) });
      await registerSelfHealSpine();
      const run = await executor();
      await run(evt(SELF_HEAL_EVENTS.trigger, { workflow: { id: "wf", node: "deep" } }));
      const [record] = await listCases();
      expect(record.context.workflow).toEqual({ id: "wf", node: "deep" });
    } finally {
      await root.cleanup();
    }
  });
});
