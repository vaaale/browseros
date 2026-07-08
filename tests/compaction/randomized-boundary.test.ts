// Task 4.2 — Randomized-boundary test for spec 022 SC-001.
//
// Enumerate a wide set of forced boundary indices over a recorded tool-heavy
// transcript. For each, apply the view transform (with and without a summary
// spliced in) and assert:
//   1. no orphan tool-call / tool-result pairs (SC-001)
//   2. kept tail begins at a user message (FR-008)
//   3. structure is a valid provider prompt shape (roles present, parts arrays)
//
// Runs under Node 22's built-in test runner:
//   node --test --experimental-strip-types tests/compaction/randomized-boundary.test.ts

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";

import { applyView, findTailStart, type CompactionView } from "../../src/lib/agent/compaction/view";
import type { Sidecar } from "../../src/lib/agent/compaction/sidecar";
import { computeSpanHash } from "../../src/lib/agent/compaction/sidecar";
import { buildToolHeavyConversation } from "./fixtures/tool-heavy";

type Msg = LanguageModelV3Prompt[number];

const CONFIG: CompactionView = {
  clearThreshold: 0.1,
  summarizeThreshold: 0.15,
  hardLimit: 0.25,
  keepToolResults: 2,
  keepTailMessages: 4,
  tailBudgetFraction: 0.2,
  unrecoverableTools: [],
};

function emptySidecar(): Sidecar {
  return {
    boundary: null,
    summary: null,
    clearWatermark: 0,
    lock: null,
    updatedAt: new Date(0).toISOString(),
    stats: { estimatedTokens: 0, compactedAt: new Date(0).toISOString(), runs: 0 },
  };
}

function collectToolCallIds(messages: LanguageModelV3Prompt): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const p of m.content) if (p.type === "tool-call") ids.add(p.toolCallId);
  }
  return ids;
}

function collectToolResultIds(messages: LanguageModelV3Prompt): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool") {
      for (const p of m.content) if (p.type === "tool-result") ids.add(p.toolCallId);
    } else if (m.role === "assistant") {
      for (const p of m.content) if (p.type === "tool-result") ids.add(p.toolCallId);
    }
  }
  return ids;
}

function firstNonSystem(messages: LanguageModelV3Prompt): Msg | null {
  for (const m of messages) if (m.role !== "system") return m;
  return null;
}

function assertProviderShape(messages: LanguageModelV3Prompt): void {
  for (const m of messages) {
    assert.ok(m && typeof m === "object", "message is an object");
    assert.ok(["system", "user", "assistant", "tool"].includes(m.role), `unexpected role: ${(m as { role: string }).role}`);
    if (m.role === "system") {
      assert.equal(typeof m.content, "string", "system content is a string");
    } else {
      assert.ok(Array.isArray(m.content), `${m.role} content is an array`);
    }
  }
}

describe("Task 4.2 — SC-001 randomized boundary", () => {
  const conversation = buildToolHeavyConversation(10);
  // The transcript is: system + 10 * (user, assistant-toolcall, tool-result, assistant-text).

  it("view transform preserves pair completeness at every clearWatermark", () => {
    const budget = 1000; // small budget so thresholds bite
    for (let watermark = 0; watermark < conversation.length; watermark++) {
      const sidecar: Sidecar = { ...emptySidecar(), clearWatermark: watermark };
      const result = applyView(conversation.slice(1), sidecar, CONFIG, budget);
      const callIds = collectToolCallIds(result.messages);
      const resultIds = collectToolResultIds(result.messages);
      // Every tool-result kept in view corresponds to a tool-call kept in view.
      for (const id of resultIds) {
        assert.ok(callIds.has(id), `orphan tool-result @ watermark=${watermark}: ${id}`);
      }
      // The transform never drops messages — Layer 1 only rewrites tool_result output.
      assert.equal(result.messages.length, conversation.length - 1, "layer1 preserves message count");
      assertProviderShape(result.messages);
    }
  });

  it("summary splice keeps a well-formed prompt at every candidate boundary", () => {
    const budget = 1000;
    const rest = conversation.slice(1); // drop the system prefix (middleware handles it)
    // Enumerate boundaries at every prompt-index that lands after a user message.
    for (let boundaryCount = 1; boundaryCount < rest.length; boundaryCount++) {
      const span = rest.slice(0, boundaryCount);
      const spanHash = computeSpanHash(span);
      const sidecar: Sidecar = {
        ...emptySidecar(),
        boundary: { count: boundaryCount, spanHash },
        summary: "**User intent & success criteria**\n- test.",
      };
      const result = applyView(rest, sidecar, CONFIG, budget);
      if (!result.stats.summarySpliced) continue; // sidecar boundary was invalid — skip
      // First non-system message is the injected summary (user role).
      const first = firstNonSystem(result.messages);
      assert.ok(first, `no messages left after splice @ boundary=${boundaryCount}`);
      assert.equal(first!.role, "user", `first spliced message is user @ boundary=${boundaryCount}`);
      // Second message must also be a user (kept tail starts at user; FR-008).
      const second = result.messages[1];
      if (second) {
        assert.equal(second.role, "user", `second message post-splice is user @ boundary=${boundaryCount}`);
      }
      // Pair completeness on the whole spliced result.
      const callIds = collectToolCallIds(result.messages);
      const resultIds = collectToolResultIds(result.messages);
      for (const id of resultIds) {
        assert.ok(callIds.has(id), `orphan tool-result post-splice @ boundary=${boundaryCount}: ${id}`);
      }
      assertProviderShape(result.messages);
    }
  });

  it("findTailStart walks back so the tail lands on a user message", () => {
    const rest = conversation.slice(1);
    const idx = findTailStart(rest, 3, 0.2, 800);
    assert.ok(idx >= 0 && idx < rest.length, "tail index in range");
    assert.equal(rest[idx].role, "user", "tail begins at a user message");
  });
});
