// The tool-DECLARATION half of the move. _contract.ts covers what the tools DO;
// this file covers what the model is told about them, and what the run loop is
// allowed to do with them.
//
// Both halves are needed. A port that preserved every behaviour but renamed a
// parameter, dropped the "this is the user's sandbox, NOT BOS source" warning,
// or quietly marked a writer parallel-safe would sail through the behavioural
// suite and still break real runs.
//
// The expectations below are FROZEN from the frontend declarations as they
// stood before the move (src/lib/assistant/tools/frontend-declarations.ts at
// 0a54d8035). They are written out longhand rather than imported so that
// deleting that file cannot silently delete the assertion with it.
//
//   npm run test:unit -- tests/assistant/file-tools-parity.test.ts

import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { strict as assert } from "node:assert";
import type { AssistantTool } from "../../src/lib/assistant/tools";
import type { Agent } from "../../src/lib/agent/subagents/types";

/** Name → {properties, required} exactly as the browser-executed declarations
 *  offered them. The model's call sites are trained on these; changing one is a
 *  breaking change to every persisted agent that declares the tool. */
const FROZEN_SCHEMA: Record<string, { properties: string[]; required: string[] }> = {
  file_list: { properties: ["path"], required: [] },
  file_read: { properties: ["path"], required: ["path"] },
  file_write: { properties: ["path", "content"], required: ["path", "content"] },
  file_mkdir: { properties: ["path"], required: ["path"] },
  file_delete: { properties: ["path"], required: ["path"] },
  file_rename: { properties: ["path", "to"], required: ["path", "to"] },
};

/** Read-only lookups are safe to run concurrently with each other and with
 *  their neighbours; the four mutating ops are not. Pre-move this lived in
 *  PARALLEL_SAFE_FRONTEND_TOOLS, which deliberately listed only the readers —
 *  "two concurrent writes to one path" is the race it existed to prevent. */
const PARALLEL_SAFE = new Set(["file_list", "file_read"]);

function params(tool: AssistantTool): { properties: Record<string, unknown>; required: string[] } {
  const p = tool.parameters as { properties?: Record<string, unknown>; required?: string[] };
  return { properties: p.properties ?? {}, required: p.required ?? [] };
}

test("all six VFS CRUD tools are server-executable, with their frozen schemas", async () => {
  const { fileTools } = await import("../../src/lib/assistant/tools/server/files");
  const tools = fileTools();

  for (const [name, frozen] of Object.entries(FROZEN_SCHEMA)) {
    const tool = tools[name];
    assert.ok(tool, `fileTools() must expose ${name}`);
    assert.equal(tool.execution, "server", `${name} must be server-executable`);
    assert.ok(typeof tool.execute === "function", `${name} must have an executor`);

    const { properties, required } = params(tool);
    assert.deepEqual(Object.keys(properties).sort(), [...frozen.properties].sort(), `${name} properties`);
    assert.deepEqual([...required].sort(), [...frozen.required].sort(), `${name} required`);
  }
});

test("only the read-only VFS tools are marked parallel-safe", async () => {
  const { fileTools } = await import("../../src/lib/assistant/tools/server/files");
  const tools = fileTools();
  for (const name of Object.keys(FROZEN_SCHEMA)) {
    assert.equal(
      tools[name].parallelSafe === true,
      PARALLEL_SAFE.has(name),
      `${name} parallelSafe should be ${PARALLEL_SAFE.has(name)} — concurrent writes to one path are the race this guards`,
    );
  }
});

test("no VFS CRUD tool is left on the frontend execution path", async () => {
  // The failure this prevents is a HALF-migration: a tool declared in both
  // places, where which one wins depends on registry spread order.
  const { FRONTEND_TOOL_DECLARATIONS } = await import("../../src/lib/assistant/tools/frontend-declarations");
  const leftBehind = FRONTEND_TOOL_DECLARATIONS.map((d) => d.name).filter((n) => n in FROZEN_SCHEMA);
  assert.deepEqual(leftBehind, [], "these are now server tools and must not also be declared as frontend tools");
});

test("the assembled registry resolves each one to the server implementation", async () => {
  // Driving the registry, not the module: registry.ts spreads frontendTools()
  // before fileTools(), so a stale frontend declaration would be SHADOWED here
  // and look fine while still being offered to a browser-less run.
  const { assistantTools } = await import("../../src/lib/assistant/registry");
  const tools = assistantTools();
  for (const name of Object.keys(FROZEN_SCHEMA)) {
    assert.ok(tools[name], `${name} must be in the assembled registry`);
    assert.equal(tools[name].execution, "server", `${name} must resolve to the server implementation`);
  }
});

test("descriptions keep the sandbox warning that steers agents away from BOS source", async () => {
  // Not cosmetic. These tools see only data/vfs; an agent that believes they
  // reach src/ hunts for BOS's own code here and finds nothing — the failure
  // mode config.ts's system prompt calls out by name.
  const { fileTools } = await import("../../src/lib/assistant/tools/server/files");
  const tools = fileTools();
  for (const name of ["file_list", "file_read", "file_write"]) {
    expect(tools[name].description, `${name} description`).toMatch(/NOT BrowserOS source|not BrowserOS source/i);
  }
});

test("EHS-0026: a headless NAMED agent's gate now includes the VFS write tools", async () => {
  // The production regression this move exists to close. Build Studio is a
  // NAMED agent running headless; `headlessGate` keeps only server-executable
  // tools, so while file_write was frontend-only it was stripped from the
  // allowlist — yet find_tools still advertised it. The agent burned 69 tool
  // calls over 2.3 hours reaching for a tool it could never call.
  const { headlessGate } = await import("../../src/lib/agent/subagents/ephemeral-tools");
  const { gateFromAgent } = await import("../../src/lib/assistant/gate");
  const { assistantTools } = await import("../../src/lib/assistant/registry");

  const named: Agent = {
    id: "build-studio-like",
    name: "Build Studio",
    description: "a named agent that runs headless",
    type: "local",
    systemPrompt: "x",
    tools: ["file_read", "file_write", "file_list"],
  };

  const gate = headlessGate(named, assistantTools(), await gateFromAgent(named));
  for (const name of named.tools!) {
    assert.ok(gate.allow.has(name), `${name} must survive the headless gate for a named agent`);
  }
});
