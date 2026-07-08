// Task 4.3 — Below-threshold byte-identity test for spec 022 SC-002.
//
// A conversation whose estimate is below `clearThreshold * budget` must be
// returned byte-identically by `applyView`, and the middleware must not create
// the sidecar directory. Repeated invocations must produce identical output
// (SC-003 byte-identity).
//
//   node --test --experimental-strip-types tests/compaction/passthrough.test.ts

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { applyView, type CompactionView } from "../../src/lib/agent/compaction/view";
import type { Sidecar } from "../../src/lib/agent/compaction/sidecar";
import { estimateTokens, estimateBudget } from "../../src/lib/agent/compaction/estimate";
import { buildTinyConversation } from "./fixtures/tool-heavy";

const CONFIG: CompactionView = {
  clearThreshold: 0.5,
  summarizeThreshold: 0.75,
  hardLimit: 0.92,
  keepToolResults: 5,
  keepTailMessages: 10,
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

describe("Task 4.3 — SC-002 pass-through below threshold", () => {
  it("returns the input byte-identically", () => {
    const messages = buildTinyConversation().slice(1);
    const budget = estimateBudget({ maxTokens: 4096, assumedContextTokens: 128_000 });
    // Confirm we are below clearThreshold * budget with room to spare.
    const est = estimateTokens(messages);
    assert.ok(est < CONFIG.clearThreshold * budget, `precondition: est=${est} < ${CONFIG.clearThreshold * budget}`);

    const before = JSON.stringify(messages);
    const result = applyView(messages, emptySidecar(), CONFIG, budget);
    assert.equal(result.transformed, false, "transformed=false below threshold");
    // Reference equality — the transform must not have copied the array.
    assert.equal(result.messages, messages, "same array reference below threshold");
    assert.equal(JSON.stringify(result.messages), before, "byte-identical serialization");
  });

  it("is deterministic across repeated invocations", () => {
    const messages = buildTinyConversation().slice(1);
    const budget = 100_000;
    const a = applyView(messages, emptySidecar(), CONFIG, budget);
    const b = applyView(messages, emptySidecar(), CONFIG, budget);
    assert.equal(JSON.stringify(a.messages), JSON.stringify(b.messages), "output identical on repeat");
  });
});
