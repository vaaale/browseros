// Hand-run unit tests for tool-state.ts (042-tool-color-coding). No test runner
// is wired into package.json — matches the convention in
// src/lib/assistant/__tests__/inner-loop.test.ts: exported async test*()
// functions plus a `runAll()` entry, so the suite can be executed from an ad-hoc
// script or wrapped in describe/it once a runner ships.
//
// SC-001 is the load-bearing test: the panel's classification must agree with
// the run's gate for every (allow, deferred, revealed) combination. It is
// written as a PREDICATE-IDENTITY check against the real `visibleTools` from
// src/lib/assistant/tools.ts (the exact per-step decision the agent loop makes)
// — not a re-statement of the rule — so the two cannot drift.
//
// It also pins design risk 1: the revealed set is derived by `deriveRevealedIds`
// from `@/lib/assistant/messages` (client-safe, `ChatMessage[]`-shaped), NOT the
// server-only same-named function in src/lib/agent/tool-gate.ts.

import { classifyToolState, DISCOVERY_TOOL_IDS, type ToolState } from "../tool-state";
import { visibleTools, type AssistantTool, type ToolGateConfig } from "@/lib/assistant/tools";
import { deriveRevealedIds, type ChatMessage } from "@/lib/assistant/messages";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

/** The registry tool ids used across the matrix. */
const REGISTRY_IDS = ["file_read", "file_write", "run_command"];

function tool(name: string): AssistantTool {
  return { name, description: `${name} description`, parameters: {}, execution: "server" };
}

function makeTools(ids: string[]): Record<string, AssistantTool> {
  return Object.fromEntries(ids.map((id) => [id, tool(id)]));
}

function makeGate(allow: string[], deferred: string[]): ToolGateConfig {
  return {
    allow: new Set(allow),
    deferred: new Set(deferred),
    registryIds: new Set(REGISTRY_IDS),
    descriptions: {},
  };
}

/** The panel's classification, for the same inputs the run's gate gets. */
function classify(id: string, gate: ToolGateConfig, revealed: Set<string>): ToolState {
  return classifyToolState(id, {
    allow: gate.allow,
    deferred: gate.deferred,
    revealed,
    isDiscovery: DISCOVERY_TOOL_IDS.has(id),
  });
}

/** A state the model can actually call: green (always visible) or blue
 *  (deferred but revealed). Orange and grey are both "not callable right now". */
function isCallable(state: ToolState): boolean {
  return state === "granted" || state === "deferredRevealed";
}

/** Every subset of `xs`, as arrays. */
function subsets<T>(xs: T[]): T[][] {
  return xs.reduce<T[][]>((acc, x) => [...acc, ...acc.map((s) => [...s, x])], [[]]);
}

/**
 * SC-001 — predicate identity. For EVERY combination of allowlist, deferred set
 * and revealed set over the registry ids, a row is coloured callable
 * (granted | deferredRevealed) if and only if `visibleTools` — the real gate the
 * run applies per step — admits that tool.
 */
export async function testSc001ClassificationMatchesRunGate(): Promise<void> {
  const tools = makeTools(REGISTRY_IDS);
  let checked = 0;
  for (const allow of subsets(REGISTRY_IDS)) {
    for (const deferred of subsets(REGISTRY_IDS)) {
      for (const revealedIds of subsets(REGISTRY_IDS)) {
        const gate = makeGate(allow, deferred);
        const revealed = new Set(revealedIds);
        const visible = new Set(visibleTools(tools, gate, revealed).map((t) => t.name));
        for (const id of REGISTRY_IDS) {
          const state = classify(id, gate, revealed);
          assert(
            isCallable(state) === visible.has(id),
            `mismatch for ${id}: state=${state} (callable=${isCallable(state)}) but visibleTools ${visible.has(id) ? "admits" : "rejects"} it` +
              ` [allow=${JSON.stringify(allow)} deferred=${JSON.stringify(deferred)} revealed=${JSON.stringify(revealedIds)}]`,
          );
          checked++;
        }
      }
    }
  }
  // 8 allow-subsets × 8 deferred-subsets × 8 revealed-subsets × 3 ids.
  assert(checked === 8 * 8 * 8 * 3, `expected 1536 comparisons, made ${checked}`);
}

/** The four states are each reachable, and reachable only under their rule
 *  (FR-002 / FR-003 / FR-004 / FR-005). */
export async function testFourStatesAreDistinct(): Promise<void> {
  const gate = makeGate(["file_read", "file_write", "run_command"], ["file_write", "run_command"]);
  const revealed = new Set(["run_command"]);
  assert(classify("file_read", gate, revealed) === "granted", "granted + non-deferred → granted (green)");
  assert(classify("file_write", gate, revealed) === "deferredHidden", "granted + deferred + hidden → deferredHidden (orange)");
  assert(classify("run_command", gate, revealed) === "deferredRevealed", "granted + deferred + revealed → deferredRevealed (blue)");
  assert(classify("file_list", gate, revealed) === "neutral", "not granted → neutral (grey)");
}

/** Edge case: an empty allowlist means ZERO granted — not "allow all". This is
 *  the strict `gate.allow.has` semantics, deliberately unlike the lenient
 *  `allows()` helper the Skills/MCP tabs use. */
export async function testEmptyAllowlistGrantsNothing(): Promise<void> {
  const gate = makeGate([], ["file_write"]);
  const revealed = new Set(["file_write"]);
  for (const id of REGISTRY_IDS) {
    assert(classify(id, gate, revealed) === "neutral", `empty allowlist must leave ${id} neutral, not granted`);
  }
}

/** Loading strictness: while the agent fetch is unresolved the caller passes
 *  empty sets (tools === null), which must render every row neutral — no green
 *  flash on tools the selected agent may not even have. */
export async function testLoadingRendersEveryRowNeutral(): Promise<void> {
  const empty = new Set<string>();
  for (const id of [...REGISTRY_IDS, "find_tools"]) {
    const state = classifyToolState(id, {
      allow: empty,
      deferred: empty,
      revealed: empty,
      isDiscovery: DISCOVERY_TOOL_IDS.has(id),
    });
    assert(state === "neutral", `while loading, ${id} must be neutral, got ${state}`);
  }
}

/** Edge case: a tool that is revealed but NOT granted is never callable, so it
 *  must be neutral — the not-granted check fires before any colour check. */
export async function testRevealedButNotGrantedIsNeutral(): Promise<void> {
  const gate = makeGate(["file_read"], ["file_write"]);
  const revealed = new Set(["file_write"]);
  assert(classify("file_write", gate, revealed) === "neutral", "revealed but not granted must be neutral, not blue");
}

/** Edge case: a granted, revealed, NON-deferred tool is simply always visible —
 *  green, never blue. Blue is reserved for the deferred/revealed pair. */
export async function testRevealedNonDeferredIsGreenNotBlue(): Promise<void> {
  const gate = makeGate(["file_read"], []);
  assert(classify("file_read", gate, new Set(["file_read"])) === "granted", "revealed + non-deferred must be green");
}

/** Edge case: discovery tools bypass the allowlist, so they must never be
 *  coloured — even when explicitly listed in an agent's tools/deferred sets.
 *  (Defensive: they are not in the capability registry, so no row renders for
 *  them today.) */
export async function testDiscoveryToolsAreAlwaysNeutral(): Promise<void> {
  for (const id of ["find_tools", "find_agent"]) {
    assert(DISCOVERY_TOOL_IDS.has(id), `${id} must be in DISCOVERY_TOOL_IDS`);
    const gate = makeGate([id], [id]);
    assert(classify(id, gate, new Set()) === "neutral", `${id} must be neutral even when allowlisted`);
    assert(classify(id, gate, new Set([id])) === "neutral", `${id} must be neutral even when revealed`);
  }
  assert(DISCOVERY_TOOL_IDS.size === 2, "DISCOVERY_TOOL_IDS mirrors exactly find_tools + find_agent");
}

/** End-to-end over a real transcript: the revealed set the panel feeds the
 *  classifier comes from the client-safe `deriveRevealedIds` in
 *  src/lib/assistant/messages.ts — the same function agent-loop.ts calls.
 *  Orange → blue on reveal, and back to orange in a conversation without it
 *  (SC-003). */
export async function testRevealedSetComesFromTranscript(): Promise<void> {
  const gate = makeGate(["file_read", "run_command"], ["run_command"]);

  const fresh: ChatMessage[] = [{ id: "m1", role: "user", content: "hi" }];
  const freshRevealed = deriveRevealedIds(fresh);
  assert(freshRevealed.size === 0, "a fresh conversation reveals nothing");
  assert(classify("run_command", gate, freshRevealed) === "deferredHidden", "fresh conversation → orange");

  const afterFind: ChatMessage[] = [
    ...fresh,
    {
      id: "m2",
      role: "assistant",
      toolCalls: [{ id: "call-1", type: "function", function: { name: "find_tools", arguments: "{}" } }],
    },
    {
      id: "m3",
      role: "tool",
      toolCallId: "call-1",
      content: JSON.stringify({ results: [{ id: "run_command" }], totalMatches: 1 }),
    },
  ];
  const afterRevealed = deriveRevealedIds(afterFind);
  assert(afterRevealed.has("run_command"), "find_tools result must reveal run_command");
  assert(classify("run_command", gate, afterRevealed) === "deferredRevealed", "after find_tools → blue");
  assert(classify("file_read", gate, afterRevealed) === "granted", "the non-deferred granted tool stays green");

  // A different conversation, without that find_tools result, is orange again.
  assert(classify("run_command", gate, deriveRevealedIds(fresh)) === "deferredHidden", "other conversation → orange again");
}

export async function runAll(): Promise<void> {
  await testSc001ClassificationMatchesRunGate();
  await testFourStatesAreDistinct();
  await testEmptyAllowlistGrantsNothing();
  await testLoadingRendersEveryRowNeutral();
  await testRevealedButNotGrantedIsNeutral();
  await testRevealedNonDeferredIsGreenNotBlue();
  await testDiscoveryToolsAreAlwaysNeutral();
  await testRevealedSetComesFromTranscript();
}
