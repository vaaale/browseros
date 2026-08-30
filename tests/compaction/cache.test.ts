// Prefix-cache-preservation property: appending a new (non-tool-call) turn to
// the tail must not change how any EARLIER message renders, given the same
// sidecar. This is what makes the compacted prompt cacheable turn over turn —
// the provider's prompt-cache prefix match only holds if the bytes before the
// new turn never change.
//
//   node --test --experimental-strip-types --conditions=react-server tests/compaction/cache.test.ts

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { renderView } from "../../src/lib/agent/compaction/render";
import type { Sidecar } from "../../src/lib/agent/compaction/sidecar";
import { buildToolHeavyConversation, userMessage, assistantText } from "./fixtures/tool-heavy";

function emptySidecar(): Sidecar {
  return {
    version: 2,
    projections: {},
    blocks: {},
    blockOrder: [],
    lock: null,
    updatedAt: new Date(0).toISOString(),
    stats: { estimatedTokens: 0, compactedAt: new Date(0).toISOString(), runs: 0 },
  };
}

describe("render.ts — prefix cache preservation", () => {
  it("prefix is unchanged when a non-tool-call turn is appended to the tail", () => {
    const convo = buildToolHeavyConversation(6);
    const sidecar = emptySidecar();
    const config = { keepToolResults: 2, unrecoverableTools: [] };

    const turn1 = renderView(convo, sidecar, config).messages;

    // Add a follow-up turn with no tool calls — doesn't shift which tool-call
    // pairs fall within the keepToolResults recency window.
    const convoNext = [...convo, userMessage("follow-up"), assistantText("ack")];
    const turn2 = renderView(convoNext, sidecar, config).messages;

    const prefix1 = turn1;
    const prefix2 = turn2.slice(0, turn2.length - 2);
    assert.equal(prefix1.length, prefix2.length, "prefix lengths match");
    assert.deepEqual(prefix1, prefix2, "prefix content matches — cacheable");
  });
});
