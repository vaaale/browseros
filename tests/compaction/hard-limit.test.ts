// Task 4.6 — Hard-limit fallback for spec 022 SC-005.
//
// With the summarizer disabled (structural: we never schedule Layer 2 here),
// a conversation past `hardLimit * budget` must still fit inside the budget
// after view/truncate is applied. Exercises `truncateToTail` — the mechanical
// fallback used by the middleware when no summary is available (FR-011).
//
//   node --test --experimental-strip-types tests/compaction/hard-limit.test.ts

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { truncateToTail, type CompactionView } from "../../src/lib/agent/compaction/view";
import { estimateTokens } from "../../src/lib/agent/compaction/estimate";
import { buildToolHeavyConversation } from "./fixtures/tool-heavy";

const CONFIG: CompactionView = {
  clearThreshold: 0.1,
  summarizeThreshold: 0.15,
  hardLimit: 0.25,
  keepToolResults: 2,
  keepTailMessages: 4,
  tailBudgetFraction: 0.2,
  unrecoverableTools: [],
};

describe("Task 4.6 — SC-005 hard-limit fallback", () => {
  it("truncateToTail returns a prompt below the summarize threshold", () => {
    const rest = buildToolHeavyConversation(40).slice(1);
    const budget = 2000;
    const startEst = estimateTokens(rest);
    assert.ok(startEst >= budget * CONFIG.hardLimit, `precondition: est=${startEst} >= hardLimit=${budget * CONFIG.hardLimit}`);
    const target = Math.floor(budget * CONFIG.summarizeThreshold);
    const truncated = truncateToTail(rest, CONFIG, target);
    const endEst = estimateTokens(truncated);
    assert.ok(endEst <= budget, `truncated fits budget: ${endEst} <= ${budget}`);
    assert.ok(truncated.length <= rest.length, "truncation reduces message count");
    // First message must be a user message (the first user of the original).
    assert.equal(truncated[0].role, "user", "first message after truncation is user");
  });

  it("truncateToTail preserves pair completeness (no orphan tool-results)", () => {
    const rest = buildToolHeavyConversation(40).slice(1);
    const target = 400;
    const truncated = truncateToTail(rest, CONFIG, target);
    const callIds = new Set<string>();
    const resultIds = new Set<string>();
    for (const m of truncated) {
      if (m.role === "assistant") {
        for (const p of m.content) if (p.type === "tool-call") callIds.add(p.toolCallId);
      } else if (m.role === "tool") {
        for (const p of m.content) if (p.type === "tool-result") resultIds.add(p.toolCallId);
      }
    }
    for (const id of resultIds) {
      assert.ok(callIds.has(id), `orphan tool-result after truncation: ${id}`);
    }
  });
});
