// ADR-12 (headless ephemeral tool fidelity) + ADR-13 (enriched delegate onEvent
// stream) for the Workflow Manager service-tools scope-add.
//
//   npm run test:unit -- tests/assistant/ephemeral-subagent-tools.test.ts
//
// Regression guard priority (design.md §9.8 #1): a NAMED agent's find_tools and
// tool gate must be byte-identical to pre-patch — only the ephemeral branch
// changes.

import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NextRequest } from "next/server";
import type { AssistantTool, ToolContext } from "../../src/lib/assistant/tools";
import type { Agent } from "../../src/lib/agent/subagents/types";

process.env.BOS_E2E_SCRIPTED = "1";

/** Redirect BOS runtime state to a throwaway dir for the test's duration and
 *  restore the previous env on cleanup (Playwright runs several test FILES in one
 *  worker process, so a stale BOS_DATA_DIR would break later tests). */
function useTempDataDir(): { data: string; cleanup: () => void } {
  const data = mkdtempSync(join(tmpdir(), "eph-subagent-"));
  const previous = process.env.BOS_DATA_DIR;
  process.env.BOS_DATA_DIR = data;
  return {
    data,
    cleanup: () => {
      if (previous === undefined) delete process.env.BOS_DATA_DIR;
      else process.env.BOS_DATA_DIR = previous;
      rmSync(data, { recursive: true, force: true });
    },
  };
}

/** A minimal `lookup` for discoveryTools that reports only the given ids as
 *  present, so find_tools tests don't pull the full assistant registry in. */
function makeLookup(ids: string[]): (id: string) => AssistantTool | undefined {
  const map: Record<string, AssistantTool> = {};
  for (const id of ids) map[id] = { name: id, description: `desc for ${id}`, parameters: {}, execution: "server", execute: async () => "ok" };
  return (id) => map[id];
}

function ctx(overrides: { agentId: string; runId: string }): ToolContext {
  return {
    signal: new AbortController().signal,
    conversationId: "conv-test",
    agentId: overrides.agentId,
    runId: overrides.runId,
    onEvent: () => undefined,
    elicit: async () => "",
    delegationDepth: 0,
  };
}

const AGENT_MD = (tools: string[], deferredTools: string[]): string =>
  [
    "---",
    "name: Named X",
    "description: A named test agent",
    "type: local",
    `tools: [${tools.join(", ")}]`,
    `deferredTools: [${deferredTools.join(", ")}]`,
    "useDefaultPrompt: false",
    "---",
    "",
    "Body.",
  ].join("\n");

test("ADR-12 (a): a named agent's headless gate is byte-identical to pre-patch", async () => {
  const { headlessGate } = await import("../../src/lib/agent/subagents/ephemeral-tools");
  const { gateFromAgent } = await import("../../src/lib/assistant/gate");

  // One server tool + one frontend (VFS) tool. A named agent declares both, with
  // a deferred tool — mirroring a real named agent's config.
  const baseTools: Record<string, AssistantTool> = {
    web_search: { name: "web_search", description: "d", parameters: {}, execution: "server", execute: async () => "ok" },
    file_read: { name: "file_read", description: "d", parameters: {}, execution: "frontend" },
  };
  const named: Agent = {
    id: "named",
    name: "Named",
    description: "d",
    type: "local",
    systemPrompt: "x",
    tools: ["web_search", "file_read"],
    deferredTools: ["web_search"],
  };
  const baseGate = await gateFromAgent(named);
  // runner.ts passes the UNBRIDGED base tools for a named agent (agent.ephemeral is falsy).
  const gate = headlessGate(named, baseTools, baseGate);

  // The pre-patch inline formula, recomputed independently:
  const expectedAllow = new Set([...(named.tools ?? [])].filter((id) => baseTools[id]?.execution === "server"));
  assert.deepEqual([...gate.allow].sort(), [...expectedAllow].sort());
  assert.deepEqual([...gate.allow].sort(), ["web_search"]); // frontend file_read excluded — pre-patch
  assert.deepEqual([...gate.deferred], []); // named headless gate forces empty deferred — pre-patch
  assert.deepEqual([...gate.registryIds], [...baseGate.registryIds]); // passthrough
  assert.deepEqual(gate.descriptions, baseGate.descriptions); // passthrough
});

test("ADR-12 (a): a named agent's find_tools still resolves via gateFor (no in-run leak)", async () => {
  const { getInRunAgent, setInRunAgent } = await import("../../src/lib/agent/subagents/in-run-agents");
  const { discoveryTools } = await import("../../src/lib/assistant/tools/server/discovery");
  const find_tools = discoveryTools(makeLookup(["web_search", "web_fetch"])).find_tools;

  // A DIFFERENT ephemeral agent is registered under "runA"; it must NOT leak
  // into a find_tools call for an unregistered runId (the named/non-registered
  // path), which falls back to gateFor(agentId) exactly as pre-patch.
  const eph: Agent = { id: "eph", name: "Eph", description: "d", type: "local", systemPrompt: "x", ephemeral: true, tools: ["web_search"], deferredTools: ["web_search"] };
  setInRunAgent("runA", eph);
  try {
    expect(getInRunAgent("runA")?.id).toBe("eph"); // sanity: runA is registered
    expect(getInRunAgent("run-not-registered")).toBeUndefined();

    // agentId "ghost" is not persisted and "run-not-registered" has no in-run
    // agent → gateFor("ghost") = empty gate → find_tools returns [] (pre-patch
    // behavior; the runA ephemeral agent is not consulted).
    const out = JSON.parse(await find_tools.execute!({ query: "search" }, ctx({ agentId: "ghost", runId: "run-not-registered" }))) as { id: string }[];
    assert.deepEqual(out, []);
  } finally {
    // cleanup via a fresh reference (in-run-agents exposes only set/get/clear)
    const { clearInRunAgent } = await import("../../src/lib/agent/subagents/in-run-agents");
    clearInRunAgent("runA");
  }
});

test("ADR-12 (a): a persisted named agent's find_tools returns its declared deferred tools", async () => {
  const data = useTempDataDir();
  try {
    const dir = join(data.data, "agents", "named-x");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "AGENT.md"), AGENT_MD(["web_search", "web_fetch"], ["web_fetch"]));

    const { discoveryTools } = await import("../../src/lib/assistant/tools/server/discovery");
    const find_tools = discoveryTools(makeLookup(["web_search", "web_fetch"])).find_tools;

    // A runId NOT in the in-run registry → gateFor("named-x") → the named
    // agent's own gate. web_fetch is deferred + allowed → returned; web_search
    // is allowed but not deferred → NOT returned.
    const out = JSON.parse(await find_tools.execute!({ query: "fetch" }, ctx({ agentId: "named-x", runId: "run-not-registered" }))) as { id: string }[];
    assert.deepEqual(out.map((r) => r.id).sort(), ["web_fetch"]);
  } finally {
    data.cleanup();
  }
});

test("ADR-12 (b): an ephemeral agent's find_tools returns its declared deferred tools (FR-034/SC-021)", async () => {
  const { setInRunAgent, clearInRunAgent } = await import("../../src/lib/agent/subagents/in-run-agents");
  const { discoveryTools } = await import("../../src/lib/assistant/tools/server/discovery");
  const find_tools = discoveryTools(makeLookup(["web_search", "web_fetch", "file_read"])).find_tools;

  // An ephemeral agent is never persisted, so getAgent(id) is undefined; its
  // deferred tools are only reachable through the in-run agent object.
  const eph: Agent = {
    id: "eph-researcher",
    name: "Ephemeral Researcher",
    description: "d",
    type: "local",
    systemPrompt: "x",
    ephemeral: true,
    tools: ["web_search", "web_fetch", "file_read"],
    deferredTools: ["web_fetch", "file_read"],
  };
  setInRunAgent("run-eph", eph);
  try {
    const out = JSON.parse(await find_tools.execute!({ query: "fetch read" }, ctx({ agentId: "eph-researcher", runId: "run-eph" }))) as { id: string }[];
    // Both declared deferred tools are discovered (incl. the frontend file_read,
    // which is lookupable); web_search is allowed but not deferred → absent.
    assert.deepEqual(out.map((r) => r.id).sort(), ["file_read", "web_fetch"]);
  } finally {
    clearInRunAgent("run-eph");
  }
});

test("ADR-13 (c): the headless ephemeral run's onEvent emits tool_result (name+result+ok) + final text", async () => {
  const data = useTempDataDir();
  try {
    const { runSubAgent } = await import("../../src/lib/agent/subagents/runner");
    const path = "/Documents/adr13-e2e.txt";
    const content = "hello adr13";
    const agent: Agent = {
      id: "eph-writer",
      name: "Eph Writer",
      description: "d",
      type: "local",
      systemPrompt: "You write files.",
      ephemeral: true,
      tools: ["file_write", "file_read"],
    };
    const task = `@@e2e ${JSON.stringify({
      turns: [
        { text: "writing", tools: [{ name: "file_write", args: { path, content } }] },
        { text: "done writing" },
      ],
    })}`;

    const events: unknown[] = [];
    const result = await runSubAgent(agent, task, { onEvent: (ev) => events.push(ev) });

    // Final assistant text is the run's output.
    assert.equal(result.output, "done writing");

    // Legacy per-tool-call event is preserved for backward compat.
    const toolCall = events.find((e) => "tool" in (e as object) && (e as { tool?: string }).tool === "file_write") as { tool: string; input: unknown };
    assert.ok(toolCall, "expected a legacy {tool,input} tool_call event");
    assert.equal((toolCall.input as { path?: string }).path, path);

    // ADR-13: the tool result is emitted with its name + result + ok/error.
    const toolResult = events.find((e) => (e as { type?: string }).type === "tool_result") as { name: string; result: string; ok: boolean };
    assert.ok(toolResult, "expected a tool_result event");
    assert.equal(toolResult.name, "file_write");
    assert.equal(toolResult.ok, true);
    assert.equal(toolResult.result, `Wrote ${path}.`);

    // ADR-13: the final text is emitted as an event.
    const finalText = events.find((e) => (e as { type?: string }).type === "final_text") as { text: string };
    assert.ok(finalText, "expected a final_text event");
    assert.equal(finalText.text, "done writing");

    // ADR-12: the frontend file_write genuinely executed server-side (bridged) —
    // the write landed in the real VFS.
    const { readText } = await import("../../src/os/vfs");
    assert.equal(await readText(path), content);
  } finally {
    data.cleanup();
  }
});

test("ADR-12 (b): an ephemeral agent's declared file tools land in its visible set (VFS bridge)", async () => {
  const { bridgeEphemeralFrontendTools, headlessGate } = await import("../../src/lib/agent/subagents/ephemeral-tools");
  const { gateFromAgent } = await import("../../src/lib/assistant/gate");
  const { visibleTools } = await import("../../src/lib/assistant/tools");

  // In the registry, file_read/file_write are FRONTEND-execution tools (see
  // frontend-declarations.ts). For an ephemeral agent, runner.ts bridges them
  // to server-side VFS calls before building the gate.
  const baseTools: Record<string, AssistantTool> = {
    file_read: { name: "file_read", description: "d", parameters: {}, execution: "frontend" },
    file_write: { name: "file_write", description: "d", parameters: {}, execution: "frontend" },
  };
  const eph: Agent = {
    id: "eph-vis",
    name: "Eph Vis",
    description: "d",
    type: "local",
    systemPrompt: "x",
    ephemeral: true,
    tools: ["file_read", "file_write"],
  };

  const bridged = bridgeEphemeralFrontendTools(baseTools, eph.tools);
  assert.equal(bridged.file_read.execution, "server"); // bridged
  assert.equal(bridged.file_write.execution, "server"); // bridged

  // The ephemeral headless gate keeps the declared tools in `allow` (filtered to
  // server-executable against the bridged map) — so both are visible from step
  // 1 of the run, not hidden behind find_tools.
  const gate = headlessGate(eph, bridged, await gateFromAgent(eph));
  assert.ok(gate.allow.has("file_read"));
  assert.ok(gate.allow.has("file_write"));
  const visible = visibleTools(bridged, gate, new Set()).map((d) => d.name).sort();
  assert.deepEqual(visible, ["file_read", "file_write"]);
});

test("ADR-13 (d): /api/subagents/delegate streams tool_result + done{text} for an ephemeral agent", async () => {
  const data = useTempDataDir();
  try {
    const { POST } = await import("../../src/app/api/subagents/delegate/route");
    const path = "/Documents/adr13-route.txt";
    const content = "route hello";
    const res = await POST(
      new NextRequest("http://local/api/subagents/delegate", {
        method: "POST",
        body: JSON.stringify({
          task: `@@e2e ${JSON.stringify({
            turns: [
              { text: "writing", tools: [{ name: "file_write", args: { path, content } }] },
              { text: "done via route" },
            ],
          })}`,
          ephemeral: { name: "Route Eph", systemPrompt: "You write files.", tools: ["file_write", "file_read"] },
        }),
      }),
    );
    assert.equal(res.status, 200);

    // Consume the NDJSON stream.
    const lines: Record<string, unknown>[] = [];
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const line of parts) if (line.trim()) lines.push(JSON.parse(line) as Record<string, unknown>);
    }
    if (buf.trim()) lines.push(JSON.parse(buf) as Record<string, unknown>);

    // The legacy per-tool-call line is preserved (backward compat).
    const toolLine = lines.find((l) => l.type === "tool") as { tool?: string };
    assert.ok(toolLine, "expected a legacy {type:'tool'} line");
    assert.equal(toolLine.tool, "file_write");

    // ADR-13: the tool_result line carries the name + result + ok.
    const resultLine = lines.find((l) => l.type === "tool_result") as { name?: string; result?: string; ok?: boolean };
    assert.ok(resultLine, "expected a {type:'tool_result'} line");
    assert.equal(resultLine.name, "file_write");
    assert.equal(resultLine.ok, true);
    assert.equal(resultLine.result, `Wrote ${path}.`);

    // ADR-13: the terminal done line carries the full result AND the final text.
    const doneLine = lines.find((l) => l.type === "done") as { result?: { output?: string }; text?: string };
    assert.ok(doneLine, "expected a {type:'done'} line");
    assert.equal(doneLine.result?.output, "done via route");
    assert.equal(doneLine.text, "done via route");
  } finally {
    data.cleanup();
  }
});
