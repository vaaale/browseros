// The "## Tool groups" system-prompt block (041-tool-groups, US1).
//
// The block is the only place group structure can be expressed at all: the
// provider's native tool field is a flat list with no group metadata. These
// tests pin the membership rules (FR-007/FR-008), D1's visible-named /
// hidden-counted asymmetry (FR-015), the exclusions (FR-005), and the ordering
// (FR-012).
//   npx playwright test -c playwright.unit.config.ts tests/assistant/tool-groups-block.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { useTestDataDir } from "../services/_test-env";
import { buildToolGroupsBlock } from "../../src/lib/agent/instructions";
import { listCapabilities } from "../../src/lib/agent/capabilities-registry";
import { registerToolGroups, unregisterToolGroups } from "../../src/lib/agent/tool-groups";
import { setGroupOverride } from "../../src/lib/agent/tool-group-overrides";
import type { AssistantTool, ToolGateConfig } from "../../src/lib/assistant/tools";

const CAPS = listCapabilities();
const idsIn = (group: string) => CAPS.filter((c) => c.group === group).map((c) => c.id);

/** A tool map where every registry capability exists, plus find_tools (which is
 *  NOT a capability — it must never appear in the block). */
const TOOLS: Record<string, AssistantTool> = Object.fromEntries(
  [...CAPS.map((c) => c.id), "find_tools", "ui_consent"].map((id) => [
    id,
    { name: id, description: "d", parameters: { type: "object" }, execution: "server" } as AssistantTool,
  ]),
);

function gate(allow: string[], deferred: string[] = []): ToolGateConfig {
  return {
    allow: new Set(allow),
    deferred: new Set(deferred),
    registryIds: new Set(CAPS.map((c) => c.id)),
    descriptions: {},
  };
}

let env: { cleanup: () => void };
test.beforeEach(() => { env = useTestDataDir("tool-groups-block"); });
test.afterEach(() => { unregisterToolGroups(["zeta-group"]); env.cleanup(); });

// ── FR-007: only groups the agent actually has ──────────────────────────────

test("a group appears only when the agent is granted something in it", async () => {
  const block = await buildToolGroupsBlock(gate(["web_search", "web_fetch"]), TOOLS);
  expect(block).toContain("WEB —");
  expect(block).not.toContain("GMAIL");
  expect(block).not.toContain("SCHEDULER");
});

test("both visible and deferred tools count towards a group being included", async () => {
  const block = await buildToolGroupsBlock(gate(["web_search"], ["web_search"]), TOOLS);
  expect(block).toContain("WEB —");
});

// ── FR-008 + D1/FR-015: named vs counted ────────────────────────────────────

test("visible tools are NAMED and hidden tools are only COUNTED", async () => {
  const block = await buildToolGroupsBlock(gate(["web_search", "web_fetch", "web_view"], ["web_fetch", "web_view"]), TOOLS);
  expect(block).toContain("web_search");
  // The hidden ones must not be named — that would defeat deferral.
  expect(block).not.toContain("web_fetch");
  expect(block).not.toContain("web_view");
  expect(block).toContain("2 more available here");
  expect(block).toContain('find_tools(group: "web")');
});

test("a group with nothing hidden gets no discovery line", async () => {
  const block = await buildToolGroupsBlock(gate(["web_search", "web_fetch"]), TOOLS);
  expect(block).toContain("web_search, web_fetch");
  expect(block).not.toContain("more available here");
});

test("an agent with zero deferred tools sees no discovery guidance anywhere", async () => {
  const block = await buildToolGroupsBlock(gate(["web_search", "file_read"]), TOOLS);
  expect(block).not.toContain("more available here");
  expect(block).not.toMatch(/hidden/i);
});

test("the singular/plural of the count line is correct", async () => {
  const one = await buildToolGroupsBlock(gate(["web_search", "web_fetch"], ["web_fetch"]), TOOLS);
  expect(one).toContain("1 more available here");
  expect(one).toContain("to see it");
});

// ── FR-005: no group for non-registry tools, and no fallback bucket ─────────

test("find_tools and other non-registry tools never appear, and no bucket is invented", async () => {
  const block = await buildToolGroupsBlock(gate(["web_search", "find_tools", "ui_consent"]), TOOLS);
  expect(block).not.toContain("ui_consent");
  expect(block).not.toMatch(/^GENERAL/m);
  expect(block).not.toContain("SERVICE TOOLS");
});

test("a granted id with no registered tool behind it is skipped, not bucketed", async () => {
  const partial: Record<string, AssistantTool> = { web_search: TOOLS.web_search };
  const block = await buildToolGroupsBlock(gate(["web_search", "gmail_messages_send"]), partial);
  expect(block).toContain("web_search");
  expect(block).not.toContain("GMAIL");
});

// ── FR-014: omitted, never emitted empty ────────────────────────────────────

test("an agent with no granted registry tools gets no block at all", async () => {
  expect(await buildToolGroupsBlock(gate([]), TOOLS)).toBe("");
  expect(await buildToolGroupsBlock(gate(["find_tools"]), TOOLS)).toBe("");
});

// ── FR-013: the preamble reaches every agent ────────────────────────────────

test("the preamble explains find_tools and rules MCP out", async () => {
  const block = await buildToolGroupsBlock(gate(["web_search"], ["web_search"]), TOOLS);
  expect(block).toContain("## Tool groups");
  expect(block).toMatch(/use find_tools whenever no visible tool fits/i);
  expect(block).toMatch(/does NOT reach MCP server tools/i);
  expect(block).toContain("mcp_tool_search");
});

// ── FR-011: static for the run ──────────────────────────────────────────────

test("the block does not vary with what has already been revealed", async () => {
  const g = gate(["web_search", "web_fetch"], ["web_fetch"]);
  const a = await buildToolGroupsBlock(g, TOOLS);
  const b = await buildToolGroupsBlock(g, TOOLS);
  expect(a).toBe(b);
  // Nothing in the text names the revealed set.
  expect(a).not.toMatch(/revealed/i);
});

// ── FR-012: ordering ────────────────────────────────────────────────────────

test("groups follow the group table order, with dynamic groups last", async () => {
  registerToolGroups([
    { id: "zeta-group", name: "Zeta", description: "A dynamically registered group for the test.", aliases: [], origin: "service" },
  ]);
  const block = await buildToolGroupsBlock(gate(["file_read", "web_search"]), TOOLS);
  // Web precedes Files in the built-in table.
  expect(block.indexOf("WEB —")).toBeLessThan(block.indexOf("FILES —"));
});

// ── FR-046: an edited group description reaches the prompt ──────────────────

test("a group description override appears in the block without a restart", async () => {
  await setGroupOverride("web", { description: "Intranet only — no external internet access." });
  const block = await buildToolGroupsBlock(gate(["web_search"]), TOOLS);
  expect(block).toContain("Intranet only");
});

// ── SC-012: the block stays an index, not a second tool listing ─────────────

test("the block never restates a tool's description", async () => {
  const block = await buildToolGroupsBlock(gate(idsIn("files")), TOOLS);
  const fileRead = CAPS.find((c) => c.id === "file_read")!;
  expect(block).toContain("file_read");
  expect(block).not.toContain(fileRead.description);
});
