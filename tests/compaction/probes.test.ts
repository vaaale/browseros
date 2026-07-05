// Task 4.5 — Probe tests for spec 022 SC-004.
//
// SC-004 requires that summarization "preserves standing constraints and
// permits recovery of a specific fact". Without calling a real provider we
// verify the STRUCTURAL invariant that makes SC-004 possible:
//
//   1. Constraint probe — a "Standing constraint" line from the summary text
//      is copied into the spliced <conversation_summary> block, unaltered.
//   2. Needle probe — a specific fact recorded in the summary appears verbatim
//      in the transformed prompt sent to the provider.
//
// The end-to-end LLM behavior is validated by the manual smoke path (Task 4.1)
// with 021 present; this test locks the plumbing.
//
//   node --test --experimental-strip-types tests/compaction/probes.test.ts

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { applyView, buildSummaryMessage, type CompactionView } from "../../src/lib/agent/compaction/view";
import type { Sidecar } from "../../src/lib/agent/compaction/sidecar";
import { computeSpanHash } from "../../src/lib/agent/compaction/sidecar";
import { buildToolHeavyConversation, userMessage } from "./fixtures/tool-heavy";

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

function serialize(messages: readonly unknown[]): string {
  return JSON.stringify(messages);
}

describe("Task 4.5 — SC-004 constraint + needle probes", () => {
  it("standing constraint from the summary is present in the spliced prompt", () => {
    const constraint = "Standing constraint: never touch package.json for the rest of this conversation.";
    const summary = [
      "**User intent & success criteria** — refactor the compaction module.",
      "**Standing constraints**",
      `- "${constraint}"`,
      "**Current state** — none",
      "**Decisions & rationale** — none",
      "**Errors & fixes** — none",
      "**Key verbatim fragments** — none",
      "**Next steps** — continue phase 4 tests",
    ].join("\n");

    const rest = buildToolHeavyConversation(8).slice(1);
    const boundary = { count: 12, spanHash: computeSpanHash(rest.slice(0, 12)) };
    const sidecar: Sidecar = { ...emptySidecar(), summary, boundary };

    const result = applyView(rest, sidecar, CONFIG, 1000);
    assert.equal(result.stats.summarySpliced, true, "summary spliced");
    const serialized = serialize(result.messages);
    assert.ok(
      serialized.includes(constraint),
      "constraint literal survived into the spliced prompt",
    );
  });

  it("needle fact from the summary is recoverable via the spliced prompt", () => {
    const needle = "the customer's order ID is 3ABC-771";
    const summary = [
      "**User intent & success criteria** — help user recall order.",
      "**Standing constraints** — none",
      "**Current state**",
      `- ${needle}`,
      "**Decisions & rationale** — none",
      "**Errors & fixes** — none",
      "**Key verbatim fragments** — none",
      "**Next steps** — none",
    ].join("\n");

    const rest = buildToolHeavyConversation(8).slice(1);
    const boundary = { count: 16, spanHash: computeSpanHash(rest.slice(0, 16)) };
    const sidecar: Sidecar = { ...emptySidecar(), summary, boundary };

    // Simulate the follow-up user question.
    const restWithQuestion = [...rest, userMessage("what is the order id again?")];
    const result = applyView(restWithQuestion, sidecar, CONFIG, 1000);
    assert.equal(result.stats.summarySpliced, true, "summary spliced");
    const serialized = serialize(result.messages);
    assert.ok(serialized.includes(needle), "needle fact recoverable from spliced summary");
  });

  it("summary is wrapped in <conversation_summary> with the recovery note", () => {
    const built = buildSummaryMessage("**User intent** — none");
    assert.equal(built.role, "user", "summary message role is user");
    assert.equal(built.content.length, 1);
    const part = built.content[0];
    assert.equal(part.type, "text", "summary content is a text part");
    const text = (part as { type: "text"; text: string }).text;
    assert.match(text, /<conversation_summary>/, "opening tag present");
    assert.match(text, /<\/conversation_summary>/, "closing tag present");
    assert.match(text, /Durable lessons may be retrievable via memory_search/, "recovery note present");
  });
});
