// tool-gate.ts — withToolGate's per-step gating fix (039-service-tool-exposure,
// T021/T023). REGISTRY_IDS used to be a module-level `Set` frozen at import
// time; a service tool registered at runtime (well after this module first
// loaded) would never show up in it and would be auto-executed regardless of
// allowlist/deferred settings. The fix derives membership from
// listCapabilities() freshly INSIDE transformParams (per model-call step), so
// these tests deliberately register the dynamic capability AFTER importing
// tool-gate.ts (and after any earlier test in this file already ran) to prove
// there is no frozen import-time snapshot being relied on.
//   npx playwright test -c playwright.unit.config.ts tests/services/tool-gate.test.ts
import "./_stub-server-only";
import { test, expect } from "@playwright/test";
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3FunctionTool, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { withToolGate } from "../../src/lib/agent/tool-gate";
import { registerAdditionalCapabilities, unregisterCapabilities } from "../../src/lib/agent/capabilities-registry";

function fakeModel(): { model: LanguageModelV3; captured: LanguageModelV3CallOptions[] } {
  const captured: LanguageModelV3CallOptions[] = [];
  const model: LanguageModelV3 = {
    specificationVersion: "v3",
    provider: "test",
    modelId: "test-model",
    supportedUrls: {},
    doGenerate: async (params) => {
      captured.push(params);
      return {} as unknown as LanguageModelV3GenerateResult;
    },
    doStream: async () => {
      throw new Error("doStream not used in this test");
    },
  };
  return { model, captured };
}

function tool(name: string): LanguageModelV3FunctionTool {
  return { type: "function", name, description: "a tool", inputSchema: { type: "object" } };
}

test.describe("withToolGate — per-step registryIds derived from listCapabilities()", () => {
  test("a service tool registered AFTER import time is still gated (proves no frozen module-level snapshot)", async () => {
    const capId = "service_dyn_tool_after_import";
    registerAdditionalCapabilities([{ id: capId, group: "Service Tools", context: "tool", description: "dyn" }]);
    try {
      const { model, captured } = fakeModel();
      // Allowlist does NOT include capId — if per-step gating works, it must
      // be filtered out even though it was registered long after this
      // module's first import.
      const gated = withToolGate(model, { allow: [], deferredTools: [], descriptions: {} });

      await gated.doGenerate({ prompt: [], tools: [tool(capId), tool("find_tools")] } as unknown as LanguageModelV3CallOptions);

      const sentNames = (captured[0].tools ?? []).map((t) => (t as { name: string }).name);
      expect(sentNames).not.toContain(capId);
      // Discovery tools are always available regardless of the registry.
      expect(sentNames).toContain("find_tools");
    } finally {
      unregisterCapabilities([capId]);
    }
  });

  test("an allowlisted, dynamically-registered service tool passes through", async () => {
    const capId = "service_dyn_tool_allowed";
    registerAdditionalCapabilities([{ id: capId, group: "Service Tools", context: "tool", description: "dyn" }]);
    try {
      const { model, captured } = fakeModel();
      const gated = withToolGate(model, { allow: [capId], deferredTools: [], descriptions: {} });

      await gated.doGenerate({ prompt: [], tools: [tool(capId)] } as unknown as LanguageModelV3CallOptions);

      const sentNames = (captured[0].tools ?? []).map((t) => (t as { name: string }).name);
      expect(sentNames).toContain(capId);
    } finally {
      unregisterCapabilities([capId]);
    }
  });

  test("a dynamically-registered service tool that is deferred and not yet revealed is hidden", async () => {
    const capId = "service_dyn_tool_deferred";
    registerAdditionalCapabilities([{ id: capId, group: "Service Tools", context: "tool", description: "dyn" }]);
    try {
      const { model, captured } = fakeModel();
      const gated = withToolGate(model, { allow: [capId], deferredTools: [capId], descriptions: {} });

      await gated.doGenerate({ prompt: [], tools: [tool(capId)] } as unknown as LanguageModelV3CallOptions);

      const sentNames = (captured[0].tools ?? []).map((t) => (t as { name: string }).name);
      expect(sentNames).not.toContain(capId);
    } finally {
      unregisterCapabilities([capId]);
    }
  });

  test("regression: a built-in capability (web_search) with an empty allowlist is still gated out", async () => {
    const { model, captured } = fakeModel();
    const gated = withToolGate(model, { allow: [], deferredTools: [], descriptions: {} });

    await gated.doGenerate({ prompt: [], tools: [tool("web_search")] } as unknown as LanguageModelV3CallOptions);

    const sentNames = (captured[0].tools ?? []).map((t) => (t as { name: string }).name);
    expect(sentNames).not.toContain("web_search");
  });

  test("regression: an allowlisted built-in capability passes through with description overrides applied", async () => {
    const { model, captured } = fakeModel();
    const gated = withToolGate(model, {
      allow: ["web_search"],
      deferredTools: [],
      descriptions: { web_search: "custom description" },
    });

    await gated.doGenerate({ prompt: [], tools: [tool("web_search")] } as unknown as LanguageModelV3CallOptions);

    const sent = (captured[0].tools ?? []).find((t) => (t as { name: string }).name === "web_search") as
      | { description?: string }
      | undefined;
    expect(sent?.description).toBe("custom description");
  });

  test("regression: a non-registry tool (e.g. an AGUI/consent tool) always passes through", async () => {
    const { model, captured } = fakeModel();
    const gated = withToolGate(model, { allow: [], deferredTools: [], descriptions: {} });

    await gated.doGenerate({ prompt: [], tools: [tool("some_frontend_only_action")] } as unknown as LanguageModelV3CallOptions);

    const sentNames = (captured[0].tools ?? []).map((t) => (t as { name: string }).name);
    expect(sentNames).toContain("some_frontend_only_action");
  });
});
