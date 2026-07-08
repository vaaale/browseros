// Task 4.4 — Cache-preservation test for spec 022 SC-003.
//
// Two consecutive turns with no threshold crossing (only a new message added to
// the tail) must produce a byte-identical transformed prefix. This is a proxy
// for a prompt-cache hit — the older bytes never change between compaction
// events.
//
//   node --test --experimental-strip-types tests/compaction/cache.test.ts

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";

import { applyView, type CompactionView } from "../../src/lib/agent/compaction/view";
import type { Sidecar } from "../../src/lib/agent/compaction/sidecar";
import { buildToolHeavyConversation, userMessage, assistantText } from "./fixtures/tool-heavy";

const CONFIG: CompactionView = {
  clearThreshold: 0.1,
  summarizeThreshold: 0.5,
  hardLimit: 0.9,
  keepToolResults: 2,
  keepTailMessages: 4,
  tailBudgetFraction: 0.2,
  unrecoverableTools: [],
};

function emptySidecar(): Sidecar {
  return {
    boundary: null,
    summary: null,
    clearWatermark: 3,
    lock: null,
    updatedAt: new Date(0).toISOString(),
    stats: { estimatedTokens: 0, compactedAt: new Date(0).toISOString(), runs: 0 },
  };
}

function hashPrompt(messages: LanguageModelV3Prompt): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

describe("Task 4.4 — SC-003 prefix cache preservation", () => {
  it("prefix is byte-identical when a message is added to the tail", () => {
    const rest = buildToolHeavyConversation(6).slice(1);
    const budget = 500; // triggers clearing but not summarization
    const sidecar = emptySidecar();

    const turn1 = applyView(rest, sidecar, CONFIG, budget).messages;

    // Add one more user turn (no threshold crossing, no watermark change).
    const restNext: LanguageModelV3Prompt = [...rest, userMessage("follow-up"), assistantText("ack")];
    const turn2 = applyView(restNext, sidecar, CONFIG, budget).messages;

    // Prefix (everything except the newest two messages) must be byte-identical.
    const prefix1 = turn1;
    const prefix2 = turn2.slice(0, turn2.length - 2);
    assert.equal(prefix1.length, prefix2.length, "prefix lengths match");
    assert.equal(hashPrompt(prefix1), hashPrompt(prefix2), "prefix hashes match — cacheable");
  });
});
