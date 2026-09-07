// Service-declared tool groups (041-tool-groups, US3 / ADR-5). A marketplace
// item names the group(s) its tools appear under in its own service.json; the
// old catch-all "Service Tools" bucket is gone and nothing replaces it.
//   npx playwright test -c playwright.unit.config.ts tests/agent/service-tool-groups.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { ServiceToolBridge } from "../../src/lib/agent/service-tool-bridge";
import { listCapabilities, unregisterCapabilities } from "../../src/lib/agent/capabilities-registry";
import { groupById, unregisterToolGroups } from "../../src/lib/agent/tool-groups";
import { validateManifest } from "../../src/core/service/manifestValidator";
import type { ToolGroupDeclaration } from "../../src/core/service/serviceToolTypes";

const TOOL_NAMES = ["wf_run", "wf_list", "kb_find"];
const GROUP_IDS = ["workflows", "knowledge"];
test.afterEach(() => {
  unregisterCapabilities(TOOL_NAMES);
  unregisterToolGroups(GROUP_IDS);
});

const WORKFLOWS: ToolGroupDeclaration = {
  id: "workflows",
  name: "Workflows",
  description: "Create, edit, run and monitor multi-step workflows.",
  aliases: ["pipeline", "automation"],
};
const KNOWLEDGE: ToolGroupDeclaration = {
  id: "knowledge",
  name: "Knowledge",
  description: "Query the knowledge base built from ingested sources.",
};

const decl = (name: string, group?: string) => ({
  name,
  description: `The ${name} tool.`,
  inputSchema: { type: "object", properties: {} },
  ...(group ? { group } : {}),
});

function manifest(over: Record<string, unknown> = {}) {
  return {
    id: "workflows",
    name: "Workflow Manager",
    version: "1.0.0",
    entry: "index.js",
    deploymentMode: "tools",
    toolGroups: [WORKFLOWS],
    ...over,
  };
}

// ── Manifest validation (FR-039): fail at install, not at first start ───────

test("a tools-mode manifest declaring groups validates", async () => {
  const res = await validateManifest(manifest());
  expect(res.errors).toEqual([]);
});

test("a tools-mode manifest with NO toolGroups is rejected at install", async () => {
  const res = await validateManifest(manifest({ toolGroups: undefined }));
  expect(res.errors.join(" ")).toContain("manifest.toolGroups is required");
});

test("a malformed group declaration names the offending field", async () => {
  const bad = await validateManifest(manifest({ toolGroups: [{ id: "Not A Slug", name: "", description: "" }] }));
  const joined = bad.errors.join(" ");
  expect(joined).toContain("toolGroups[0].id");
  expect(joined).toContain("toolGroups[0].name");
  expect(joined).toContain("toolGroups[0].description");
});

test("duplicate group ids are rejected", async () => {
  const res = await validateManifest(manifest({ toolGroups: [WORKFLOWS, { ...WORKFLOWS, name: "Other" }] }));
  expect(res.errors.join(" ")).toContain("declared more than once");
});

test("toolGroups on a non-tools service is rejected rather than ignored", async () => {
  const res = await validateManifest(manifest({ deploymentMode: "default" }));
  expect(res.errors.join(" ")).toContain('only meaningful with deploymentMode "tools"');
});

// ── Registration (FR-037/FR-038/FR-041) ────────────────────────────────────

test("a tool lands under the service's declared group, not a generic bucket", () => {
  const bridge = new ServiceToolBridge();
  expect(bridge.registerTool("workflows", decl("wf_run"), [WORKFLOWS])).toBe(true);
  const cap = listCapabilities().find((c) => c.id === "wf_run");
  expect(cap?.group).toBe("workflows");
  expect(groupById("workflows")?.name).toBe("Workflows");
  expect(groupById("workflows")?.description).toContain("multi-step workflows");
  // The retired catch-all must not reappear under any spelling.
  expect(listCapabilities().some((c) => c.group === "Service Tools")).toBe(false);
});

test("an item may declare several groups and assign each tool to one", () => {
  const bridge = new ServiceToolBridge();
  const groups = [WORKFLOWS, KNOWLEDGE];
  expect(bridge.registerTool("multi", decl("wf_run", "workflows"), groups)).toBe(true);
  expect(bridge.registerTool("multi", decl("kb_find", "knowledge"), groups)).toBe(true);
  expect(listCapabilities().find((c) => c.id === "wf_run")?.group).toBe("workflows");
  expect(listCapabilities().find((c) => c.id === "kb_find")?.group).toBe("knowledge");
});

test("with several groups declared, a tool that names none is REJECTED, not guessed", () => {
  const bridge = new ServiceToolBridge();
  expect(bridge.registerTool("multi", decl("wf_run"), [WORKFLOWS, KNOWLEDGE])).toBe(false);
  expect(listCapabilities().some((c) => c.id === "wf_run")).toBe(false);
});

test("a tool naming an undeclared group is rejected", () => {
  const bridge = new ServiceToolBridge();
  expect(bridge.registerTool("workflows", decl("wf_run", "not-declared"), [WORKFLOWS])).toBe(false);
  expect(listCapabilities().some((c) => c.id === "wf_run")).toBe(false);
});

test("a pre-041 service declaring no groups at all is rejected, not defaulted", () => {
  const bridge = new ServiceToolBridge();
  expect(bridge.registerTool("legacy", decl("wf_run"), [])).toBe(false);
  expect(listCapabilities().some((c) => c.id === "wf_run")).toBe(false);
  expect(groupById("workflows")).toBeUndefined();
});

// ── Lifecycle (FR-004) ──────────────────────────────────────────────────────

test("a group is dropped once its last tool unregisters", () => {
  const bridge = new ServiceToolBridge();
  bridge.registerTool("workflows", decl("wf_run"), [WORKFLOWS]);
  bridge.registerTool("workflows", decl("wf_list"), [WORKFLOWS]);
  bridge.unregisterTool("workflows", "wf_run");
  expect(groupById("workflows")).toBeTruthy(); // wf_list still holds it open
  bridge.unregisterTool("workflows", "wf_list");
  expect(groupById("workflows")).toBeUndefined();
});

test("unregistering a whole service drops only its own groups", () => {
  const bridge = new ServiceToolBridge();
  bridge.registerTool("a", decl("wf_run"), [WORKFLOWS]);
  bridge.registerTool("b", decl("kb_find"), [KNOWLEDGE]);
  bridge.unregisterServiceTools("a");
  expect(groupById("workflows")).toBeUndefined();
  expect(groupById("knowledge")).toBeTruthy();
});
