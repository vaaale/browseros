// gate.ts — gateFromAgent must source `registryIds` from listCapabilities(),
// not the static CAPABILITIES array, so a dynamically-registered service tool
// (039-service-tool-exposure) is gated by allowlist/deferred exactly like a
// built-in capability. Regression: built-ins are unaffected.
//   npx playwright test -c playwright.unit.config.ts tests/services/gate.test.ts
import "./_stub-server-only";
import { test, expect } from "@playwright/test";
import { gateFromAgent } from "../../src/lib/assistant/gate";
import { visibleTools } from "../../src/lib/assistant/tools";
import type { AssistantTool } from "../../src/lib/assistant/tools";
import type { Agent } from "../../src/lib/agent/subagents/types";
import { registerAdditionalCapabilities, unregisterCapabilities } from "../../src/lib/agent/capabilities-registry";

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "test-agent",
    name: "Test Agent",
    description: "",
    type: "local",
    systemPrompt: "",
    ...overrides,
  };
}

function serverTool(name: string): AssistantTool {
  return { name, description: "a tool", parameters: {}, execution: "server", execute: async () => "ok" };
}

test.describe("gateFromAgent — registryIds sourced from listCapabilities()", () => {
  test("a dynamically-registered service-tool capability id is present in registryIds", async () => {
    registerAdditionalCapabilities([
      { id: "service_svc_a_echo_tool", group: "Service Tools", context: "tool", description: "Echoes text" },
    ]);
    try {
      const gate = await gateFromAgent(agent({ tools: ["service_svc_a_echo_tool"] }));
      expect(gate.registryIds.has("service_svc_a_echo_tool")).toBe(true);
    } finally {
      unregisterCapabilities(["service_svc_a_echo_tool"]);
    }
  });

  test("a service tool NOT in the agent's allowlist is gated out by visibleTools, exactly like an ungranted built-in", async () => {
    registerAdditionalCapabilities([
      { id: "service_svc_a_echo_tool", group: "Service Tools", context: "tool", description: "Echoes text" },
    ]);
    try {
      // Allowlist grants only a built-in ("web_search"), NOT the service tool.
      const gate = await gateFromAgent(agent({ tools: ["web_search"] }));
      const tools: Record<string, AssistantTool> = {
        web_search: serverTool("web_search"),
        service_svc_a_echo_tool: serverTool("service_svc_a_echo_tool"),
      };

      const visible = visibleTools(tools, gate, new Set());
      const names = visible.map((t) => t.name);

      expect(names).toContain("web_search");
      expect(names).not.toContain("service_svc_a_echo_tool");
    } finally {
      unregisterCapabilities(["service_svc_a_echo_tool"]);
    }
  });

  test("an allowlisted service tool is visible", async () => {
    registerAdditionalCapabilities([
      { id: "service_svc_a_echo_tool", group: "Service Tools", context: "tool", description: "Echoes text" },
    ]);
    try {
      const gate = await gateFromAgent(agent({ tools: ["service_svc_a_echo_tool"] }));
      const tools: Record<string, AssistantTool> = { service_svc_a_echo_tool: serverTool("service_svc_a_echo_tool") };

      const visible = visibleTools(tools, gate, new Set());

      expect(visible.map((t) => t.name)).toContain("service_svc_a_echo_tool");
    } finally {
      unregisterCapabilities(["service_svc_a_echo_tool"]);
    }
  });

  test("regression: a built-in capability (web_search) is still gated identically with no dynamic caps registered", async () => {
    const gate = await gateFromAgent(agent({ tools: [] }));
    expect(gate.registryIds.has("web_search")).toBe(true);

    const tools: Record<string, AssistantTool> = { web_search: serverTool("web_search") };
    const visible = visibleTools(tools, gate, new Set());
    // Empty allowlist ⇒ zero registry tools (matches toolsFor()/pre-existing semantics).
    expect(visible.map((t) => t.name)).not.toContain("web_search");
  });

  test("regression: an unresolved tool id not in the registry is ignored (unresolvedToolIds), not crashed on", async () => {
    const gate = await gateFromAgent(agent({ tools: ["totally_unknown_tool_id"] }));
    expect(gate.registryIds.has("totally_unknown_tool_id")).toBe(false);
    expect(gate.allow.has("totally_unknown_tool_id")).toBe(true);
  });
});
