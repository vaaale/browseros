import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import selfHealPlugin, {
  _resetWindowsForTests,
  clearFailures,
  drainPendingIntakes,
  isToolErrorResult,
  recordFailure,
  toolErrorMessage,
} from "../../src/plugins/self-heal/index";
import { listCases } from "../../src/lib/self-heal/store";
import * as intake from "../../src/lib/self-heal/intake";
import { useSelfHealTestRoot } from "./_test-env";

// 031-self-healing FR-002/FR-003 — the trigger-capture plugin.
//
// The capture point is `afterToolCall`, not `onError`: the agent loop converts
// every tool failure into an in-band `Error: <tool>: …` RESULT STRING and never
// lets it throw (agent-loop.ts's `toolError`), so a hook watching for
// exceptions would see nothing at all. `onError` fires only for a model-turn
// failure.

test.beforeEach(() => {
  _resetWindowsForTests();
});

test.afterEach(async () => {
  // The hook dispatches intake WITHOUT awaiting (a hook must never stall a
  // turn), so a call can still be running when the test body ends. Settle it
  // before the temp root is torn down — otherwise it lands in the NEXT test's
  // data dir and fails that one instead.
  await drainPendingIntakes();
  intake._setSpineAgentHooksForTests(null);
  _resetWindowsForTests();
});

test.describe("the in-band failure convention", () => {
  test("isToolErrorResult recognizes the loop's error encoding", () => {
    expect(isToolErrorResult("Error: file_read: permission denied")).toBe(true);
    expect(isToolErrorResult("Read 3 files.")).toBe(false);
    expect(isToolErrorResult("")).toBe(false);
    // A result that merely MENTIONS an error is a success, not a failure.
    expect(isToolErrorResult("The log contains Error: something")).toBe(false);
  });

  test("toolErrorMessage strips the prefix so the signature hashes the real message", () => {
    expect(toolErrorMessage("file_read", "Error: file_read: permission denied")).toBe("permission denied");
    expect(toolErrorMessage("file_read", "Error: something else entirely")).toBe("something else entirely");
    expect(toolErrorMessage("file_read", "Error: file_read: ")).toBe("");
  });
});

test.describe("the rolling window (FR-003)", () => {
  test("the threshold trips on the Nth failure inside the window", () => {
    expect(recordFailure("k", 1_000, 3, 300)).toEqual({ total: 1, threshold: false });
    expect(recordFailure("k", 2_000, 3, 300)).toEqual({ total: 2, threshold: false });
    expect(recordFailure("k", 3_000, 3, 300)).toEqual({ total: 3, threshold: true });
  });

  test("it resets after firing, so a long-running failure does not re-trigger every call", () => {
    recordFailure("k", 1_000, 3, 300);
    recordFailure("k", 2_000, 3, 300);
    expect(recordFailure("k", 3_000, 3, 300).threshold).toBe(true);
    expect(recordFailure("k", 4_000, 3, 300)).toEqual({ total: 1, threshold: false });
  });

  test("failures older than the window drop out", () => {
    const t0 = 1_000_000;
    recordFailure("k", t0, 3, 300);
    recordFailure("k", t0 + 1_000, 3, 300);
    // 10 minutes later the first two are outside a 300s window.
    expect(recordFailure("k", t0 + 600_000, 3, 300)).toEqual({ total: 1, threshold: false });
  });

  test("a success clears the streak — 'consecutive' means consecutive", () => {
    recordFailure("k", 1_000, 3, 300);
    recordFailure("k", 2_000, 3, 300);
    clearFailures("k");
    expect(recordFailure("k", 3_000, 3, 300)).toEqual({ total: 1, threshold: false });
  });

  test("different keys are tracked independently", () => {
    recordFailure("a", 1_000, 2, 300);
    expect(recordFailure("b", 1_000, 2, 300)).toEqual({ total: 1, threshold: false });
    expect(recordFailure("a", 2_000, 2, 300).threshold).toBe(true);
  });
});

test.describe("afterToolCall → intake", () => {
  const call = { id: "c1", name: "file_read", arguments: "{}" };
  const ctx = { runId: "r1", conversationId: "c-user-1", agentId: "assistant" };
  const hook = selfHealPlugin.hooks.afterToolCall!;

  test("both triggers off ⇒ no case, and the plugin exits early", async () => {
    const root = useSelfHealTestRoot("plugin-off");
    try {
      root.writeConfig({ enabled: true, "triggers.hardError": false, "triggers.repeatedFailure": false });
      intake._setSpineAgentHooksForTests({ diagnose: async () => ({ ok: false }) });
      await hook(call, "Error: file_read: permission denied", ctx);
      expect(await listCases()).toEqual([]);
    } finally {
      await root.cleanup();
    }
  });

  test("the hard-error trigger creates a case on the FIRST non-environmental failure", async () => {
    const root = useSelfHealTestRoot("plugin-hard-error");
    try {
      root.writeConfig({ enabled: true, "triggers.hardError": true, "triggers.repeatedFailure": false });
      intake._setSpineAgentHooksForTests({ diagnose: async () => ({ ok: false }) });
      await hook(call, "Error: file_read: permission denied reading /Documents/x.md", ctx);
      await expect.poll(async () => (await listCases()).length).toBe(1);
      const [record] = await listCases();
      expect(record.trigger).toBe("hard-error");
      expect(record.context.toolName).toBe("file_read");
      expect(record.context.errorMessage).toBe("permission denied reading /Documents/x.md");
    } finally {
      await root.cleanup();
    }
  });

  test("an environmental failure creates nothing (SC-003)", async () => {
    const root = useSelfHealTestRoot("plugin-env");
    try {
      root.writeConfig({ enabled: true, "triggers.hardError": true });
      intake._setSpineAgentHooksForTests({ diagnose: async () => ({ ok: false }) });
      await hook({ ...call, name: "web_fetch" }, "Error: web_fetch: getaddrinfo ENOTFOUND api.example.com", ctx);
      expect(await listCases()).toEqual([]);
    } finally {
      await root.cleanup();
    }
  });

  test("a SUCCESSFUL call creates nothing and clears the streak", async () => {
    const root = useSelfHealTestRoot("plugin-success");
    try {
      root.writeConfig({ enabled: true, "triggers.hardError": false, "triggers.repeatedFailure": true, "repeatedFailure.count": 2 });
      intake._setSpineAgentHooksForTests({ diagnose: async () => ({ ok: false }) });
      await hook(call, "Error: file_read: permission denied", ctx);
      await hook(call, "Read the file.", ctx); // success — streak reset
      await hook(call, "Error: file_read: permission denied", ctx);
      // Only one failure since the reset, so the count-of-2 threshold is unmet.
      expect(await listCases()).toEqual([]);
    } finally {
      await root.cleanup();
    }
  });

  test("the repeated-failure trigger fires on the Nth same-signature failure", async () => {
    const root = useSelfHealTestRoot("plugin-repeated");
    try {
      root.writeConfig({
        enabled: true,
        "triggers.hardError": false,
        "triggers.repeatedFailure": true,
        "repeatedFailure.count": 3,
        "repeatedFailure.windowSec": 300,
      });
      intake._setSpineAgentHooksForTests({ diagnose: async () => ({ ok: false }) });
      // The realistic shape: an agent retrying the SAME operation. FR-003 says
      // "the same error signature", and that is what makes the streak.
      const failure = "Error: file_read: permission denied reading /Documents/report.md";
      await hook(call, failure, ctx);
      await hook(call, failure, ctx);
      expect(await listCases()).toEqual([]);
      await hook(call, failure, ctx);

      await expect.poll(async () => (await listCases()).length).toBe(1);
      const [record] = await listCases();
      expect(record.trigger).toBe("repeated-failure");
      expect(record.context.repeated).toEqual({ count: 3, windowSec: 300 });
    } finally {
      await root.cleanup();
    }
  });

  test("failures with DIFFERENT signatures do not accumulate into one streak", async () => {
    const root = useSelfHealTestRoot("plugin-repeated-distinct");
    try {
      root.writeConfig({
        enabled: true,
        "triggers.hardError": false,
        "triggers.repeatedFailure": true,
        "repeatedFailure.count": 3,
      });
      intake._setSpineAgentHooksForTests({ diagnose: async () => ({ ok: false }) });
      // Three genuinely different failures of the same tool. FR-003 is about a
      // REPEATING failure, not a busy tool — three unrelated problems must not
      // be reported as one pattern.
      await hook(call, "Error: file_read: permission denied reading /Documents/report.md", ctx);
      await hook(call, "Error: file_read: no such file or directory", ctx);
      await hook(call, "Error: file_read: path is not a file", ctx);
      expect(await listCases()).toEqual([]);
    } finally {
      await root.cleanup();
    }
  });

  test("a self-heal-origin conversation is skipped (FR-025 guard a)", async () => {
    const root = useSelfHealTestRoot("plugin-reentrancy");
    try {
      root.writeConfig({ enabled: true, "triggers.hardError": true });
      intake._setSpineAgentHooksForTests({ diagnose: async () => ({ ok: false }) });
      const { saveConversationMessages } = await import("../../src/lib/assistant/conversation-store");
      const { markSelfHealConversation } = await import("../../src/lib/self-heal/reentrancy");
      await saveConversationMessages("c-self-heal-fix-0001", "build-studio", [{ id: "m", role: "user", content: "b" }]);
      await markSelfHealConversation("c-self-heal-fix-0001", { role: "pipeline", caseId: "0001" });

      await hook(call, "Error: file_read: permission denied", { ...ctx, conversationId: "c-self-heal-fix-0001" });
      expect(await listCases()).toEqual([]);
    } finally {
      await root.cleanup();
    }
  });

  test("a hook failure never propagates into the run", async () => {
    const root = useSelfHealTestRoot("plugin-safe");
    try {
      root.writeConfig({ enabled: true, "triggers.hardError": true });
      // A malformed call object would throw inside the handler; the hook must
      // swallow it — a broken trigger capture is not worth failing a turn over.
      await hook(undefined as unknown as typeof call, "Error: x", ctx);
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("the hard-error minCount gate (FR-002 amended)", () => {
  const call = { id: "c1", name: "file_read", arguments: "{}" };
  const ctx = { runId: "r1", conversationId: "c-user-1", agentId: "assistant" };
  const hook = selfHealPlugin.hooks.afterToolCall!;
  // Same signature every time — the gate counts a STREAK, not traffic.
  const failure = "Error: file_read: permission denied reading /Documents/x.md";

  test("with minCount=3, a single failure is logged only — no case", async () => {
    const root = useSelfHealTestRoot("plugin-mincount-single");
    try {
      root.writeConfig({
        enabled: true,
        "triggers.hardError": true,
        "triggers.repeatedFailure": false,
        "hardError.minCount": 3,
      });
      intake._setSpineAgentHooksForTests({ diagnose: async () => ({ ok: false }) });
      await hook(call, failure, ctx);
      await drainPendingIntakes();
      expect(await listCases()).toEqual([]);
    } finally {
      await root.cleanup();
    }
  });

  test("with minCount=3, the third same-signature failure creates the case", async () => {
    const root = useSelfHealTestRoot("plugin-mincount-met");
    try {
      root.writeConfig({
        enabled: true,
        "triggers.hardError": true,
        "triggers.repeatedFailure": false,
        "hardError.minCount": 3,
      });
      intake._setSpineAgentHooksForTests({ diagnose: async () => ({ ok: false }) });
      await hook(call, failure, ctx);
      await hook(call, failure, ctx);
      expect(await listCases()).toEqual([]);
      await hook(call, failure, ctx);
      await expect.poll(async () => (await listCases()).length).toBe(1);
      expect((await listCases())[0].trigger).toBe("hard-error");
    } finally {
      await root.cleanup();
    }
  });

  test("with the default minCount of 1, a single failure creates a case", async () => {
    const root = useSelfHealTestRoot("plugin-mincount-default");
    try {
      // No `hardError.minCount` key on disk — the default of 1 must apply.
      root.writeConfig({ enabled: true, "triggers.hardError": true, "triggers.repeatedFailure": false });
      intake._setSpineAgentHooksForTests({ diagnose: async () => ({ ok: false }) });
      await hook(call, failure, ctx);
      await expect.poll(async () => (await listCases()).length).toBe(1);
      expect((await listCases())[0].trigger).toBe("hard-error");
    } finally {
      await root.cleanup();
    }
  });

  test("preemption: with both triggers on and a lower minCount, the streak's case is repeated-failure", async () => {
    const root = useSelfHealTestRoot("plugin-mincount-preempt");
    try {
      root.writeConfig({
        enabled: true,
        "triggers.hardError": true,
        "triggers.repeatedFailure": true,
        "hardError.minCount": 1,
        "repeatedFailure.count": 3,
        "repeatedFailure.windowSec": 300,
      });
      intake._setSpineAgentHooksForTests({ diagnose: async () => ({ ok: false }) });
      // If hard-error fired at count 1 it would open a case whose dedupe entry
      // then suppresses the streak's own repeated-failure trigger — the exact
      // preemption FR-002 forbids. So the first two failures must create NOTHING.
      await hook(call, failure, ctx);
      await hook(call, failure, ctx);
      await drainPendingIntakes();
      expect(await listCases()).toEqual([]);
      await hook(call, failure, ctx);
      await expect.poll(async () => (await listCases()).length).toBe(1);
      expect((await listCases())[0].trigger).toBe("repeated-failure");
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("onError (a model-turn failure)", () => {
  const ctx = { runId: "r1", conversationId: "c-user-1", agentId: "assistant" };
  const hook = selfHealPlugin.hooks.onError!;

  test("a non-environmental provider failure reaches the front door", async () => {
    const root = useSelfHealTestRoot("plugin-onerror");
    try {
      root.writeConfig({ enabled: true, "triggers.hardError": true });
      intake._setSpineAgentHooksForTests({ diagnose: async () => ({ ok: false }) });
      await hook(new Error("tool schema for bos_app_launch is not valid"), ctx);
      await expect.poll(async () => (await listCases()).length).toBe(1);
      expect((await listCases())[0].context.toolName).toBe("assistant.model-turn");
    } finally {
      await root.cleanup();
    }
  });

  test("a rate-limited provider does NOT create a case", async () => {
    const root = useSelfHealTestRoot("plugin-onerror-env");
    try {
      root.writeConfig({ enabled: true, "triggers.hardError": true });
      intake._setSpineAgentHooksForTests({ diagnose: async () => ({ ok: false }) });
      await hook(new Error("429 rate limit exceeded"), ctx);
      expect(await listCases()).toEqual([]);
    } finally {
      await root.cleanup();
    }
  });

  test("with the hard-error trigger off, nothing happens", async () => {
    const root = useSelfHealTestRoot("plugin-onerror-off");
    try {
      root.writeConfig({ enabled: true, "triggers.hardError": false });
      await hook(new Error("boom"), ctx);
      expect(await listCases()).toEqual([]);
    } finally {
      await root.cleanup();
    }
  });
});

test.describe("the plugin manifest", () => {
  test("declares the hooks it actually implements", () => {
    expect(selfHealPlugin.manifest.id).toBe("bos-self-heal");
    expect(selfHealPlugin.manifest.provides).toEqual(["afterToolCall", "onError"]);
    expect(Object.keys(selfHealPlugin.hooks).sort()).toEqual(["afterToolCall", "onError"]);
    // The real configuration surface is Settings → Self Improvement; the plugin
    // panel must point there rather than growing a second set of toggles.
    expect(selfHealPlugin.manifest.settingsRegistration?.description).toContain("Self Improvement");
  });
});
