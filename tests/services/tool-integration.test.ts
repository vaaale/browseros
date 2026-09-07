// End-to-end US1 (MVP) integration: a REAL worker-thread service opted into
// `deploymentMode: "tools"` declares a tool at startup; the tool surfaces in
// the real `assistantTools()` registry; the real agent loop invokes it via
// `runServerTool` (execution: "server") → ServiceToolBridge → ServiceManager's
// dispatcher → worker IPC → the worker executes it and the result comes back
// to the model. Also covers the schema-rejection path (FR-004): invalid args
// never dispatch a `tool_call` to the worker.
//   npx playwright test -c playwright.unit.config.ts tests/services/tool-integration.test.ts
import "./_stub-server-only";
import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import { ServiceManager } from "../../src/core/service/ServiceManager";
import { serviceRegistry } from "../../src/core/service/ServiceRegistry";
import { serviceToolBridge } from "../../src/lib/agent/service-tool-bridge";
import { assistantTools } from "../../src/lib/assistant/registry";
import { runAgentLoop } from "../../src/lib/assistant/agent-loop";
import type { AgentLoopDeps, StreamTurn, TurnResult } from "../../src/lib/assistant/agent-loop";
import type { ChatMessage } from "../../src/lib/assistant/messages";
import type { RunEventInput } from "../../src/lib/assistant/run-events";
import { visibleTools, type ToolGateConfig } from "../../src/lib/assistant/tools";
import { gateFromAgent } from "../../src/lib/assistant/gate";
import { listCapabilities } from "../../src/lib/agent/capabilities-registry";
import type { ServiceManifest } from "../../src/core/service/types";
import { useTestDataDir, resetServiceSingletons } from "./_test-env";
import { installToolFixtureService, ECHO_TOOL_NAME } from "./_tool-service-fixtures";

// 041-tool-groups: a tools-mode manifest must declare the group(s) its tools
// appear under — registerTool rejects anything that resolves to none, since the
// old "Service Tools" fallback bucket is gone.
const FIXTURE_TOOL_GROUPS = [
  {
    id: "fixture-tools",
    name: "Fixture Tools",
    description: "Tools declared by the worker-thread fixture service used in these tests.",
  },
];

function manifest(id: string): ServiceManifest {
  return { id, name: id, version: "1.0.0", entry: "index.js", deploymentMode: "tools", toolGroups: FIXTURE_TOOL_GROUPS };
}

// Same "everything visible" gate the existing agent-loop tests use — gating
// of dynamically-registered service tools is Phase 3 (US2), out of scope here.
function openGate(): ToolGateConfig {
  return { allow: new Set(), deferred: new Set(), registryIds: new Set(), descriptions: {} };
}

function scriptedProvider(turns: TurnResult[]): StreamTurn {
  let i = 0;
  return async () => {
    const turn = turns[i++];
    if (!turn) throw new Error(`scripted provider exhausted at turn ${i}`);
    return turn;
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function setupTest(label: string) {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- useTestDataDir is a test helper (temp-dir setup), not a React hook
  const { dir, cleanup } = useTestDataDir(label);
  resetServiceSingletons();
  return {
    dir,
    dispose: () => {
      resetServiceSingletons();
      cleanup();
    },
  };
}

test.describe("service tool exposure — end to end (US1)", () => {
  test("a real worker's declared tool surfaces in assistantTools() and the agent loop invokes it via runServerTool", async () => {
    const { dir, dispose } = setupTest("tool-integration-happy");
    try {
      installToolFixtureService(dir, "svc");
      serviceRegistry().registerInstalled("svc", manifest("svc"), "/items/svc");
      const manager = new ServiceManager();
      await manager.start("svc", { startupTimeout: 5_000 });
      expect(serviceRegistry().getService("svc")?.state).toBe("running");

      // tool_declare arrives asynchronously right after "initialized" — wait
      // for the bridge to actually have it before building the tool registry.
      await waitFor(() => serviceToolBridge().registry.has(`svc:${ECHO_TOOL_NAME}`));

      const tools = assistantTools();
      expect(tools[ECHO_TOOL_NAME]).toBeTruthy();
      expect(tools[ECHO_TOOL_NAME].execution).toBe("server");

      const events: RunEventInput[] = [];
      let messages: ChatMessage[] = [];
      const deps: AgentLoopDeps = {
        runId: "run-1",
        conversationId: "c-1",
        agentId: "default_agent",
        signal: new AbortController().signal,
        emit: (e) => events.push(e),
        streamTurn: scriptedProvider([
          { text: "", toolCalls: [{ id: "c1", name: ECHO_TOOL_NAME, arguments: JSON.stringify({ text: "hi" }) }] },
          { text: "done", toolCalls: [] },
        ]),
        composeSystem: async () => "system prompt",
        tools,
        gate: openGate(),
        io: {
          loadMessages: async () => [...messages],
          saveMessages: async (m) => {
            messages = [...m];
          },
        },
        awaitFrontendResult: async () => ({ kind: "timeout" }),
        maxSteps: 5,
        toolTimeoutMs: 5_000,
      };

      const result = await runAgentLoop(deps, { userMessage: { content: `call ${ECHO_TOOL_NAME}` } });

      expect(result.reason).toBe("completed");
      const toolMessage = messages.find((m) => m.role === "tool");
      expect(toolMessage?.content).toBe("hi");
      expect(toolMessage?.toolCallId).toBe("c1");
      expect(events.some((e) => e.type === "tool_result" && e.result === "hi")).toBe(true);

      await manager.stop("svc");
    } finally {
      dispose();
    }
  });

  // FR-005/US2: proves the REAL tool_declare → bridge → capability-registry
  // wiring, not just the manually-simulated capability used by
  // gate.test.ts/tool-gate.test.ts. Without ServiceToolBridge also calling
  // registerAdditionalCapabilities on registration, a live service tool's name
  // never lands in listCapabilities(), so gate.ts/tool-gate.ts's `registryIds`
  // would never contain it and tool-gate.ts's "not in registry ⇒ always
  // allowed" branch would auto-execute it regardless of allowlist/deferred
  // settings — silently defeating the gating guarantee for every real service
  // tool while the hand-simulated unit tests stayed green.
  test("a real worker's declared tool is gated by allowlist exactly like a built-in (FR-005)", async () => {
    const { dir, dispose } = setupTest("tool-integration-gating");
    try {
      installToolFixtureService(dir, "svc");
      serviceRegistry().registerInstalled("svc", manifest("svc"), "/items/svc");
      const manager = new ServiceManager();
      await manager.start("svc", { startupTimeout: 5_000 });
      await waitFor(() => serviceToolBridge().registry.has(`svc:${ECHO_TOOL_NAME}`));

      // The capability registry (not just the bridge's own map) now knows
      // about the live tool, under the same id as its model-facing name.
      // 041-tool-groups: filed under the manifest's own declared group; the
      // shared "Service Tools" bucket no longer exists.
      expect(listCapabilities().some((c) => c.id === ECHO_TOOL_NAME && c.group === "fixture-tools")).toBe(true);

      const tools = assistantTools();

      // An agent whose allowlist does NOT include the service tool must not
      // see it — same as an ungranted built-in.
      const restrictedGate = await gateFromAgent({
        id: "restricted",
        name: "Restricted",
        description: "",
        type: "local",
        systemPrompt: "",
        tools: ["web_search"],
      });
      expect(restrictedGate.registryIds.has(ECHO_TOOL_NAME)).toBe(true);
      const restrictedVisible = visibleTools(tools, restrictedGate, new Set()).map((t) => t.name);
      expect(restrictedVisible).not.toContain(ECHO_TOOL_NAME);

      // An agent that DOES allowlist it sees it.
      const allowedGate = await gateFromAgent({
        id: "allowed",
        name: "Allowed",
        description: "",
        type: "local",
        systemPrompt: "",
        tools: [ECHO_TOOL_NAME],
      });
      const allowedVisible = visibleTools(tools, allowedGate, new Set()).map((t) => t.name);
      expect(allowedVisible).toContain(ECHO_TOOL_NAME);

      await manager.stop("svc");
      // Stopping the service must also drop the capability descriptor, so the
      // name doesn't linger as a dangling "always allowed" registry entry.
      expect(listCapabilities().some((c) => c.id === ECHO_TOOL_NAME)).toBe(false);
    } finally {
      dispose();
    }
  });

  test("schema-rejected args never dispatch a tool_call to the worker; a subsequent valid call still succeeds", async () => {
    const { dir, dispose } = setupTest("tool-integration-schema-reject");
    try {
      installToolFixtureService(dir, "svc");
      serviceRegistry().registerInstalled("svc", manifest("svc"), "/items/svc");
      const manager = new ServiceManager();
      await manager.start("svc", { startupTimeout: 5_000 });
      await waitFor(() => serviceToolBridge().registry.has(`svc:${ECHO_TOOL_NAME}`));

      const logsPath = serviceRegistry().getService("svc")!.logsPath;

      // Missing the required "text" field — rejected in the kernel before any
      // IPC round trip, so the worker's own "tool_call received" log line
      // (posted only once it actually handles a tool_call) must never appear.
      await expect(serviceToolBridge().invoke("svc", ECHO_TOOL_NAME, {})).rejects.toThrow();
      expect(safeRead(logsPath)).not.toContain("tool_call received");
      expect(serviceRegistry().getService("svc")?.state).toBe("running");

      // A valid call afterward proves the tool (and the service) are still
      // fully functional — the rejection didn't corrupt any state.
      const result = await serviceToolBridge().invoke("svc", ECHO_TOOL_NAME, { text: "hello" });
      expect(result).toBe("hello");
      await waitFor(() => safeRead(logsPath).includes("tool_call received"));

      await manager.stop("svc");
    } finally {
      dispose();
    }
  });
});
