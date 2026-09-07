// find_tools response modes (041-tool-groups, FR-024 – FR-034). Driven through
// the REAL tool, with the gate supplied by an in-run (ephemeral) agent so no
// filesystem agent fixture is needed.
//   npx playwright test -c playwright.unit.config.ts tests/assistant/discovery-modes.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { useTestDataDir } from "../services/_test-env";
import { discoveryTools } from "../../src/lib/assistant/tools/server/discovery";
import { setInRunAgent, clearInRunAgent } from "../../src/lib/agent/subagents/in-run-agents";
import { listCapabilities } from "../../src/lib/agent/capabilities-registry";
import type { Agent } from "../../src/lib/agent/subagents/types";
import type { AssistantTool, ToolContext } from "../../src/lib/assistant/tools";

const RUN_ID = "run-discovery-modes";

const FILES = listCapabilities().filter((c) => c.group === "files").map((c) => c.id);
const GMAIL = listCapabilities().filter((c) => c.group === "gmail").map((c) => c.id);

/** Every tool "exists" in the registry for lookup purposes. */
const lookup = (id: string): AssistantTool | undefined => {
  const cap = listCapabilities().find((c) => c.id === id);
  if (!cap) return undefined;
  return { name: id, description: cap.description, parameters: { type: "object" }, execution: "server" };
};

const findTools = discoveryTools(lookup).find_tools;

function agent(tools: string[], deferredTools: string[]): Agent {
  return {
    id: "ephemeral-test",
    name: "Test",
    description: "test agent",
    type: "local",
    systemPrompt: "",
    tools,
    deferredTools,
  } as Agent;
}

async function call(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ctx = { runId: RUN_ID, agentId: "ephemeral-test" } as unknown as ToolContext;
  const raw = await findTools.execute!(input, ctx);
  return JSON.parse(typeof raw === "string" ? raw : raw.text) as Record<string, unknown>;
}

type Row = { id: string; description: string; reasons?: unknown[] };
const idsOf = (o: Record<string, unknown>) => ((o.results ?? []) as Row[]).map((r) => r.id);

let env: { cleanup: () => void };
test.beforeEach(() => {
  env = useTestDataDir("discovery-modes");
  // Everything granted; Files + Gmail hidden, so both a small and a large group
  // are exercised.
  setInRunAgent(RUN_ID, agent(listCapabilities().map((c) => c.id), [...FILES, ...GMAIL]));
});
test.afterEach(() => {
  clearInRunAgent(RUN_ID);
  env.cleanup();
});

// ── FR-024a / ADR-7: no schemas in the payload ──────────────────────────────

test("results carry id, description and reasons — and NEVER a schema", async () => {
  const out = await call({ query: "read a text file" });
  expect(idsOf(out).length).toBeGreaterThan(0);
  for (const r of (out.results as Row[])) {
    expect(r).not.toHaveProperty("schema");
    expect(typeof r.description).toBe("string");
    expect(Array.isArray(r.reasons)).toBe(true);
  }
  // The whole payload, not just each row.
  expect(JSON.stringify(out)).not.toContain('"schema"');
});

// ── FR-024b: group mode is uncapped ─────────────────────────────────────────

test("group mode returns EVERY hidden tool of the group, past the free-text cap", async () => {
  const out = await call({ group: "files" });
  // maxFindResults defaults to 10; Files has more than that.
  expect(FILES.length).toBeGreaterThan(10);
  expect(idsOf(out).sort()).toEqual([...FILES].sort());
  expect(out.withheld).toBe(0);
  expect(out.totalMatches).toBe(FILES.length);
});

test("group mode resolves a display name, not just an id", async () => {
  const byName = await call({ group: "Gmail" });
  const byId = await call({ group: "gmail" });
  expect(idsOf(byName).sort()).toEqual(idsOf(byId).sort());
  expect(idsOf(byName).length).toBe(GMAIL.length);
});

// ── FR-032 / FR-033: never a silent empty result ────────────────────────────

test("an unknown group errors and lists the groups the agent actually has", async () => {
  const out = await call({ group: "not-a-real-group" });
  expect(out.results).toEqual([]);
  expect(String(out.error)).toContain("not-a-real-group");
  const groups = out.groups as { id: string }[];
  expect(groups.length).toBeGreaterThan(0);
  expect(groups.map((g) => g.id)).toContain("files");
});

test("a real group with nothing hidden says so instead of returning empty", async () => {
  const out = await call({ group: "web" }); // granted but not deferred
  expect(out.results).toEqual([]);
  expect(String(out.message)).toMatch(/already visible/i);
  expect(Array.isArray(out.alreadyVisible)).toBe(true);
});

test("a query matching nothing returns the group index rather than []", async () => {
  const out = await call({ query: "order me a pizza" });
  expect(out.results).toEqual([]);
  expect((out.groups as unknown[]).length).toBeGreaterThan(0);
});

test("an unsearchable query is explained (FR-027)", async () => {
  const out = await call({ query: "what is the" });
  expect(out.results).toEqual([]);
  expect(String(out.message)).toMatch(/no searchable terms/i);
});

test("calling with neither query nor group is reported, not silently empty", async () => {
  const out = await call({});
  expect(String(out.message)).toContain("Provide");
});

// ── FR-026: already-visible matches are reported, not revealed ──────────────

test("a match the agent already has visible is reported separately", async () => {
  // Only Files is hidden here; web_search is granted and visible.
  setInRunAgent(RUN_ID, agent(listCapabilities().map((c) => c.id), FILES));
  const out = await call({ query: "search the internet online" });
  expect(idsOf(out)).not.toContain("web_search");
  const visible = (out.alreadyVisible ?? []) as Row[];
  expect(visible.map((v) => v.id)).toContain("web_search");
});

// ── FR-024: truncation is disclosed, never silent ───────────────────────────

test("free-text results past the cap report how many were withheld", async () => {
  const out = await call({ query: "file" });
  const total = out.totalMatches as number;
  const shown = idsOf(out).length;
  expect(shown).toBeLessThanOrEqual(10);
  if (total > shown) {
    expect(out.withheld).toBe(total - shown);
    expect(String(out.message)).toMatch(/not shown/i);
  }
});

// ── FR-031: search never widens the allowlist ───────────────────────────────

test("a tool the agent is not granted is never returned by either mode", async () => {
  setInRunAgent(RUN_ID, agent(["file_read"], ["file_read"]));
  expect(idsOf(await call({ query: "read a file" }))).toEqual(["file_read"]);
  expect(idsOf(await call({ group: "files" }))).toEqual(["file_read"]);
});

// ── Both parameters together ────────────────────────────────────────────────

test("query + group ranks within that group only", async () => {
  const out = await call({ query: "convert a document", group: "files" });
  expect(idsOf(out).length).toBeGreaterThan(0);
  expect(idsOf(out).every((id) => FILES.includes(id))).toBe(true);
});
