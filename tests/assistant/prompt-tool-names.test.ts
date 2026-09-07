// SC-010: no generated prompt text may name a tool that doesn't exist.
//
// This exists because it had already gone wrong, twice and silently. The MCP
// index block told the model to call `searchMcpTools`, `getMcpToolSchema`,
// `callMcpTool` and `listMcpServerTools` — none of which are real ids (they are
// `mcp_tool_search`, `mcp_tool_schema`, `mcp_tool_call`, `mcp_server_tools`) —
// and the Knowledge Bases block named `kbs_tool_search`/`kbs_tool_retrieve`,
// which were stale names from an item's early design doc rather than the
// `kb_search`/`kb_retrieve` it actually ships. Nothing failed; the model just
// called tools that didn't exist.
//   npx playwright test -c playwright.unit.config.ts tests/assistant/prompt-tool-names.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { useTestDataDir } from "../services/_test-env";
import {
  buildKbIndexBlock,
  buildMcpIndexBlock,
  buildSkillsIndexBlock,
  buildToolGroupsBlock,
} from "../../src/lib/agent/instructions";
import { listCapabilities } from "../../src/lib/agent/capabilities-registry";
import { assistantTools } from "../../src/lib/assistant/registry";
import type { AssistantTool, ToolGateConfig } from "../../src/lib/assistant/tools";

const CAPS = listCapabilities();

/** Ids that legitimately appear in prompt text without being registry
 *  capabilities: the always-available discovery tools, and the MCP gateway
 *  tools (which ARE capabilities, but this list documents intent). */
const ALWAYS_AVAILABLE = new Set(["find_tools", "find_agent"]);

/** Tools the Knowledge Base marketplace item exposes over MCP. They are not BOS
 *  capabilities — they are reached through the MCP gateway — so the prompt may
 *  name them, but they must match what the item actually ships. */
const KNOWN_MCP_ITEM_TOOLS = new Set(["kb_search", "kb_retrieve"]);

function knownName(name: string): boolean {
  return (
    CAPS.some((c) => c.id === name) ||
    ALWAYS_AVAILABLE.has(name) ||
    KNOWN_MCP_ITEM_TOOLS.has(name) ||
    assistantTools()[name] !== undefined
  );
}

/** Tool-name-shaped tokens: snake_case with at least one underscore, or a
 *  camelCase identifier immediately followed by "(" (how a prompt writes a
 *  call). Deliberately loose — a false positive here is a cheap fix, a false
 *  negative is the bug this test exists to catch. */
function toolNameCandidates(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)) out.add(m[1]);
  for (const m of text.matchAll(/\b([a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*)\s*\(/g)) out.add(m[1]);
  return [...out];
}

/** Words that look like snake_case ids but are prose or paths, not tools. */
const NOT_TOOLS = new Set([
  "e_g", "i_e", "read_only", "system_prompt", "tool_call", "tool_result",
  "group_id", "input_schema", "find_tools", "spec_md",
]);

function offenders(text: string): string[] {
  return toolNameCandidates(text).filter((n) => !NOT_TOOLS.has(n) && !knownName(n));
}

const TOOLS: Record<string, AssistantTool> = Object.fromEntries(
  CAPS.map((c) => [c.id, { name: c.id, description: "d", parameters: {}, execution: "server" } as AssistantTool]),
);

function gate(allow: string[], deferred: string[] = []): ToolGateConfig {
  return { allow: new Set(allow), deferred: new Set(deferred), registryIds: new Set(CAPS.map((c) => c.id)), descriptions: {} };
}

test("the MCP index block names only real tools", () => {
  const block = buildMcpIndexBlock(undefined, [
    { name: "example", endpoint: "http://localhost:1", transport: "http", description: "An example server." } as never,
  ]);
  expect(block).not.toBe("");
  expect(offenders(block), `MCP block names non-existent tools`).toEqual([]);
  // The specific regression.
  expect(block).not.toContain("searchMcpTools");
  expect(block).not.toContain("callMcpTool");
  expect(block).toContain("mcp_tool_search");
});

test("the Knowledge Bases block names only real tools", () => {
  const block = buildKbIndexBlock(undefined, [{ id: "kb1", name: "Handbook", description: "Company handbook." } as never]);
  expect(block).not.toBe("");
  expect(offenders(block)).toEqual([]);
  expect(block).not.toContain("kbs_tool_search");
  expect(block).toContain("kb_search");
});

test("the Skills index block names only real tools", () => {
  const block = buildSkillsIndexBlock(undefined, [
    { id: "s1", name: "A skill", description: "Does a thing.", whenToUse: "always" } as never,
  ]);
  expect(offenders(block)).toEqual([]);
});

test("the tool-groups block names only real tools", async () => {
  const env = useTestDataDir("prompt-tool-names");
  try {
    const block = await buildToolGroupsBlock(gate(CAPS.map((c) => c.id), ["web_fetch"]), TOOLS);
    expect(block).not.toBe("");
    expect(offenders(block)).toEqual([]);
  } finally {
    env.cleanup();
  }
});

/** Names that were once written into prompt text or tool descriptions and are
 *  not real tool ids. Kept as an explicit list rather than a heuristic: a
 *  general scan of descriptions flags PARAMETER names (`output_path`,
 *  `ephemeralName`, `maxBytes`), which are not tool references, and the actual
 *  regression ("call searchMcpTools to find the right tool") had no syntax to
 *  key off anyway. An explicit list is honest about what it checks. */
const RETIRED_TOOL_NAMES = [
  "searchMcpTools",
  "getMcpToolSchema",
  "callMcpTool",
  "listMcpServerTools",
  "kbs_tool_search",
  "kbs_tool_retrieve",
];

test("no tool description resurrects a retired tool name", () => {
  const bad: string[] = [];
  for (const [name, tool] of Object.entries(assistantTools())) {
    for (const stale of RETIRED_TOOL_NAMES) {
      if (tool.description.includes(stale)) bad.push(`${name} description names "${stale}"`);
    }
  }
  expect(bad).toEqual([]);
});
