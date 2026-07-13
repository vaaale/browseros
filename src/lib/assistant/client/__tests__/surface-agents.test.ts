// Hand-run unit tests for client/surface-agents.ts (025-agent-delegation-v2).
// No test runner is wired into package.json — matches
// src/lib/agent/scratchpad/__tests__/handlers.test.ts's convention.
//
// DOWNGRADED FROM E2E DELIBERATELY (plan-review, tasks.md T048):
// src/apps/ui-preview/manifest.ts sets `singleton: true`, so two real UI
// Preview windows can never coexist in the running app — Example 7 / US-4
// acceptance scenario 4 (two windows of the SAME app registering a surface
// agent with the same `name`) is untestable as a true browser e2e test for
// this specific app. This calls registerSurfaceAgent directly with two
// different windowIds instead, bypassing the OS-level singleton entirely —
// fine, since the behavior under test is the client registry's own
// id-disambiguation logic, not window management.

import { registerSurfaceAgent, getActiveSurfaceAgents, unregisterSurfaceAgent } from "../surface-agents";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

function mockFetchPersistedIds(ids: string[]): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ subAgents: ids.map((id) => ({ id })) }),
  })) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

export async function testTwoWindowsSameNameGetDisambiguatedIds(): Promise<void> {
  const restore = mockFetchPersistedIds([]); // no persisted collision
  try {
    unregisterSurfaceAgent("win-a");
    unregisterSurfaceAgent("win-b");

    await registerSurfaceAgent("win-a", {
      name: "Generative UI Agent",
      description: "d1",
      systemPrompt: "p1",
      toolNames: ["ui_preview_generate"],
    });
    await registerSurfaceAgent("win-b", {
      name: "Generative UI Agent",
      description: "d2",
      systemPrompt: "p2",
      toolNames: ["ui_preview_generate"],
    });

    const agents = getActiveSurfaceAgents();
    const a = agents.find((a) => a.windowId === "win-a");
    const b = agents.find((a) => a.windowId === "win-b");
    assert(a && b, "both windows should have a registered surface agent");
    assert(a!.id === "generative-ui-agent", `expected win-a's id to be the plain slug, got ${a!.id}`);
    assert(b!.id !== a!.id, `expected win-b's id to be disambiguated, both got ${b!.id}`);
    assert(b!.id.startsWith("generative-ui-agent-"), `expected a windowId-derived suffix, got ${b!.id}`);
  } finally {
    unregisterSurfaceAgent("win-a");
    unregisterSurfaceAgent("win-b");
    restore();
  }
}

export async function testPersistedIdCollisionIsRejected(): Promise<void> {
  const restore = mockFetchPersistedIds(["assistant"]); // "assistant" is a real persisted agent
  try {
    unregisterSurfaceAgent("win-c");
    await registerSurfaceAgent("win-c", {
      name: "Assistant", // slugifies to "assistant" — collides with the persisted default
      description: "d",
      systemPrompt: "p",
      toolNames: [],
    });
    const agents = getActiveSurfaceAgents();
    assert(!agents.some((a) => a.windowId === "win-c"), "a surface agent colliding with a persisted id must NOT be registered");
  } finally {
    unregisterSurfaceAgent("win-c");
    restore();
  }
}

export async function runAll(): Promise<void> {
  await testTwoWindowsSameNameGetDisambiguatedIds();
  await testPersistedIdCollisionIsRejected();
}
