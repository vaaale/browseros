// Layer 2/2b: which turns are ready to fold into a new block, and eviction.
// The most important property here is CONTIGUITY-SAFETY: a protected/already-
// grouped turn must be a hard break, never something block-formation "skips
// over while still counting" — otherwise a block's summary would render out
// of chronological order relative to the turn it skipped past.
//
//   node --test --experimental-strip-types --conditions=react-server tests/compaction/blocks.test.ts

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { findEligibleBlocks, evictOldestBlocks } from "../../src/lib/agent/compaction/blocks";
import { turnStarts } from "../../src/lib/agent/compaction/turns";
import type { Sidecar, Block } from "../../src/lib/agent/compaction/sidecar";
import { buildToolHeavyConversation, userMessage, assistantText, assistantToolCall } from "./fixtures/tool-heavy";

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

function makeBlock(id: string, memberIds: string[]): Block {
  return { id, summary: "s", memberIds, turnCount: memberIds.length, createdAt: new Date(0).toISOString() };
}

describe("blocks.ts — findEligibleBlocks", () => {
  it("forms a block once a full blockSize window of pending turns accumulates before the tail cutoff", () => {
    const convo = buildToolHeavyConversation(10); // 10 turns, 4 msgs each = 40 messages
    const tailCutIndex = 32; // keep the last 2 turns (indices 32-39) live
    const eligible = findEligibleBlocks(convo, emptySidecar(), tailCutIndex, [], 5);
    // Turns 1..7 are eligible (turn 0 is protected/pinned); with blockSize=5,
    // exactly one full block forms (turns 1-5), turns 6-7 are a leftover
    // partial run that doesn't form yet.
    assert.equal(eligible.length, 1);
    assert.equal(eligible[0].messages.length, 20, "5 turns x 4 messages");
    assert.equal(eligible[0].messages[0].id, convo[4].id, "block starts at turn 1 (turn 0 is pinned)");
  });

  it("does not re-offer turns already grouped into an existing block", () => {
    const convo = buildToolHeavyConversation(10);
    const tailCutIndex = 32;
    const sidecar = emptySidecar();
    const turn1to5 = convo.slice(4, 24); // turns 1-5
    sidecar.blocks.b1 = makeBlock("b1", turn1to5.map((m) => m.id));
    sidecar.blockOrder = ["b1"];
    for (const m of turn1to5) sidecar.projections[m.id] = { blockId: "b1" };

    const eligible = findEligibleBlocks(convo, sidecar, tailCutIndex, [], 5);
    assert.equal(eligible.length, 0, "only turns 6-7 remain pending — not a full block yet");
  });

  it("CRITICAL: a protected turn in the middle is a hard break — never skipped-over while counting", () => {
    // 6 turns: 0 (pinned), 1, 2, 3 (calls an unrecoverable tool — protected),
    // 4, 5. With blockSize=2 and no gap-skipping, eligible runs are
    // [1,2] and [4,5] independently — never a block spanning across turn 3.
    const convo: ReturnType<typeof buildToolHeavyConversation> = [];
    for (let t = 0; t < 6; t++) {
      convo.push(userMessage(`turn ${t}`));
      if (t === 3) {
        const { message } = assistantToolCall("delete_forever", { t });
        convo.push(message);
      } else {
        convo.push(assistantText(`ok ${t}`));
      }
    }
    const tailCutIndex = convo.length; // nothing held back as "live tail" for this test
    const eligible = findEligibleBlocks(convo, emptySidecar(), tailCutIndex, ["delete_forever"], 2);

    assert.equal(eligible.length, 2, "two independent 2-turn blocks, not one spanning the break");
    const starts = turnStarts(convo);
    // First eligible block = turns 1,2 (starts[1], starts[2]).
    assert.equal(eligible[0].messages[0].id, convo[starts[1]].id);
    // Second eligible block = turns 4,5 — must NOT include turn 3's messages.
    assert.equal(eligible[1].messages[0].id, convo[starts[4]].id);
    for (const block of eligible) {
      for (const m of block.messages) assert.notEqual(m.id, convo[starts[3]].id, "protected turn 3 leaked into a block");
    }
  });

  it("never forms a block from the pinned first turn", () => {
    const convo = buildToolHeavyConversation(3);
    const tailCutIndex = convo.length;
    const eligible = findEligibleBlocks(convo, emptySidecar(), tailCutIndex, [], 1);
    for (const block of eligible) {
      assert.notEqual(block.messages[0].id, convo[0].id, "first turn's user message never starts a block");
    }
  });
});

describe("blocks.ts — evictOldestBlocks", () => {
  it("is a no-op when under the cap", () => {
    const sidecar = emptySidecar();
    sidecar.blocks.b1 = makeBlock("b1", ["m1"]);
    sidecar.blockOrder = ["b1"];
    const result = evictOldestBlocks(sidecar, 5);
    assert.equal(result, sidecar);
  });

  it("evicts the oldest blocks first and fully cleans up their projections", () => {
    const sidecar = emptySidecar();
    sidecar.blocks.b1 = makeBlock("b1", ["m1", "m2"]);
    sidecar.blocks.b2 = makeBlock("b2", ["m3"]);
    sidecar.blocks.b3 = makeBlock("b3", ["m4"]);
    sidecar.blockOrder = ["b1", "b2", "b3"];
    sidecar.projections = { m1: { blockId: "b1" }, m2: { blockId: "b1" }, m3: { blockId: "b2" }, m4: { blockId: "b3" } };

    const result = evictOldestBlocks(sidecar, 1);
    assert.deepEqual(result.blockOrder, ["b3"]);
    assert.equal(result.blocks.b1, undefined);
    assert.equal(result.blocks.b2, undefined);
    assert.ok(result.blocks.b3);
    assert.equal(result.projections.m1, undefined, "evicted block's member projection removed");
    assert.equal(result.projections.m2, undefined);
    assert.equal(result.projections.m3, undefined);
    assert.ok(result.projections.m4, "retained block's member projection kept");
  });
});
